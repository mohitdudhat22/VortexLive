const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const dotenv = require('dotenv');
const Stream = require('./models/Stream');
const RtmpDestination = require('./models/RtmpDestination');
const { spawn } = require('child_process');
const fs = require('fs');
const morgan = require('morgan');
const logger = require('./utils/logger');
const { convertToBuffer, constructRtmpUrl } = require('./helper/converToBuffer.mjs');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

app.use(morgan('combined', {
  stream: { write: msg => logger.info(msg.trim()) }
}));

app.use('/api/streams', require('./routes/streams'));
app.use('/api/rtmp', require('./routes/rtmp'));

// Verify ffmpeg binary works
try {
  const { spawnSync } = require('child_process');
  const probe = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8' });
  if (probe.error) {
    console.error('[ffmpeg] Failed to execute:', probe.error.message);
  }
} catch (e) {
  console.error('[ffmpeg] Validation error:', e.message);
}

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/streamingApp')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));



// In-memory storage for chat messages and muted users
const chatMessages = {};
const mutedUsers = {};

// Store active stream pipes per room
const streamPipes = {};
// Socket.io logic for handling WebRTC signaling
io.on('connection', (socket) => {
  function spawnSafeFFmpeg(ffmpegPath, ffmpegArgs, roomId, destination, opts = {}) {
    const ffmpeg = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    const localLogger = opts.logger || (typeof logger !== 'undefined' ? logger : console);
    const metricsIntervalMs = typeof opts.metricsIntervalMs === 'number' ? opts.metricsIntervalMs : 1000;

    const nowTs = () => new Date().toISOString();
    const log = (level, ...args) => {
      try {
        if (localLogger && localLogger[level]) localLogger[level](...args);
        else console[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'](...args);
      } catch (e) { console.log(...args); }
    };

    const entry = {
      process: ffmpeg,
      stdin: ffmpeg.stdin,
      platform: destination.platform,
      stats: { chunks: 0, bytes: 0, frames: 0, lastFrameAt: 0, fps: 0, bitrate: null, time: null, speed: null, lastLogAt: Date.now(), backpressureEvents: 0 },
      wroteHeader: false,
      dead: false,
      stdinEnded: false,
      _isStreaming: false,
      _lastStatusEmit: 0,
      _metricsTimer: null,

      safeWrite(chunk) { // returns boolean same as stream.write or false on dead
        if (this.dead || this.stdinEnded) return false;
        if (!this.stdin || this.stdin.destroyed || !this.stdin.writable) return false;
        try {
          const ok = this.stdin.write(chunk);
          this.stats.chunks += 1;
          this.stats.bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
          if (!ok) {
            this.stats.backpressureEvents += 1;
            log('warn', `[${nowTs()}][${this.platform}] backpressure: safeWrite returned false (#${this.stats.backpressureEvents}) chunks=${this.stats.chunks} bytes=${this.stats.bytes}`);
          }
          return ok;
        } catch (err) {
          log('error', `[${nowTs()}][${this.platform}] safeWrite error:`, err && err.message);
          this.stdinEnded = true;
          return false;
        }
      },

      shutdown(graceMs = 2000) {
        if (this.dead) return;
        try {
          log('warn', `[${nowTs()}][${this.platform}] shutting down ffmpeg (SIGTERM) pid=${this.process.pid}`);
          this.process.kill('SIGTERM');
        } catch (_) { }
        setTimeout(() => {
          if (!this.dead) {
            try {
              log('warn', `[${nowTs()}][${this.platform}] force-killing ffmpeg (SIGKILL) pid=${this.process.pid}`);
              this.process.kill('SIGKILL');
            } catch (_) { }
          }
        }, graceMs);
      }
    };

    // keep stderr buffer truncated
    let stderrBuf = '';
    const MAX_STDERR = 16 * 1024; // keep last 16KB for debugging

    const emitStatus = (status, extra = {}) => {
      const now = Date.now();
      if (now - entry._lastStatusEmit < 250 && status === 'streaming') return;
      entry._lastStatusEmit = now;
      try {
        console.log(status, "<<<<<<<<<<<<<<< emitStatus")
        io.to(roomId).emit('rtmp-platform-status', Object.assign({ platform: entry.platform, status, pid: ffmpeg.pid, args: ffmpegArgs }, extra));
      } catch (e) {
        log('error', `[${nowTs()}][${entry.platform}] emit error:`, e && e.message);
      }
    };

    const emitMetrics = () => {
      try {
        const metrics = {
          platform: entry.platform,
          pid: ffmpeg.pid,
          metricsAt: Date.now(),
          stats: Object.assign({}, entry.stats),
          lastStderr: stderrBuf.slice(-1024)
        };
        io.to(roomId).emit('rtmp-platform-metrics', metrics);
      } catch (e) {
        log('error', `[${nowTs()}][${entry.platform}] emitMetrics error:`, e && e.message);
      }
    };

    // Parse frame/fps/bitrate/time/speed from ffmpeg stderr lines
    const parseProgress = (line) => {
      // typical line: "frame=  234 fps= 29 q=28.0 size=   10240kB time=00:00:07.80 bitrate=10758.9kbits/s speed=0.971x"
      const mFrame = line.match(/frame=\s*([0-9]+)/i);
      const mFps = line.match(/fps=\s*([\d.]+)/i);
      const mSize = line.match(/size=\s*([\dA-Za-z.]+)/i);
      const mTime = line.match(/time=\s*([\d:.]+)/i);
      const mBitrate = line.match(/bitrate=\s*([\d.]+\w?bits\/s)/i) || line.match(/bitrate=\s*([\d.]+)/i);
      const mSpeed = line.match(/speed=\s*([\d.]+x)/i);

      if (mFrame) {
        entry.stats.frames = parseInt(mFrame[1], 10);
        entry.stats.lastFrameAt = Date.now();
      }
      if (mFps) entry.stats.fps = parseFloat(mFps[1]);
      if (mBitrate) entry.stats.bitrate = mBitrate[1];
      if (mTime) entry.stats.time = mTime[1];
      if (mSpeed) entry.stats.speed = mSpeed[1];
    };

    // Log the command up-front
    log('log', `[${nowTs()}][${destination.platform}] spawning ffmpeg pid=${ffmpeg.pid || 'pending'} cmd=${ffmpegPath} ${ffmpegArgs.join(' ')}`);

    ffmpeg.stderr.on('data', d => {
      const out = d.toString();
      stderrBuf += out;
      if (stderrBuf.length > MAX_STDERR) stderrBuf = stderrBuf.slice(-MAX_STDERR);

      // trim and log last few lines but not spam
      const trimmed = out.trim().split(/\r?\n/).slice(-5).join(' | ');
      log('log', `[${nowTs()}][${entry.platform}] ffmpeg stderr:`, trimmed);

      // update progress if we see frame/fps/time etc
      try {
        // split lines and scan for progress lines
        out.split(/\r?\n/).forEach(line => {
          if (!line) return;
          if (/(frame=|fps=|bitrate=|time=|speed=)/i.test(line)) {
            parseProgress(line);
            // mark streaming when we see key phrases
            if (!entry._isStreaming) {
              entry._isStreaming = true;
              emitStatus('streaming');
              log('log', `[${nowTs()}][${entry.platform}] detected streaming start (progress line).`);
            }
          }

          // detect fatal-ish errors (case-insensitive)
          if (/(Connection refused|403 Forbidden|401 Unauthorized|Invalid data|timed out|Failed to open|Could not write header|Failed to write|Unknown error)/i.test(line)) {
            emitStatus('error', { error: 'RTMP connection failed', detail: line.slice(0, 400) });
            log('error', `[${nowTs()}][${entry.platform}] fatal ffmpeg message:`, line.trim());
            try { ffmpeg.kill('SIGTERM'); } catch (e) { log('error', `[${nowTs()}][${entry.platform}] kill error:`, e && e.message); }
          }
        });
      } catch (e) {
        log('error', `[${nowTs()}][${entry.platform}] stderr parse error:`, e && e.message);
      }
    });

    // optional: capture stdout lines for debugging
    ffmpeg.stdout && ffmpeg.stdout.on && ffmpeg.stdout.on('data', d => {
      try {
        const s = String(d).trim();
        if (s) log('log', `[${nowTs()}][${entry.platform}] ffmpeg stdout:`, s.split(/\r?\n/).slice(-3).join(' | '));
      } catch (e) { /* ignore */ }
    });

    // errors
    ffmpeg.on('error', (e) => {
      entry.dead = true;
      entry.stdinEnded = true;
      log('error', `[${nowTs()}][${entry.platform}] ffmpeg error:`, e && (e.message || e));
      if (streamPipes[roomId]) {
        streamPipes[roomId].ffmpegProcesses = streamPipes[roomId].ffmpegProcesses.filter(p => p !== entry);
      }
      try { io.to(roomId).emit('rtmp-stream-error', { success: false, message: `${entry.platform} failed: ${e && e.message}`, platform: entry.platform, pid: ffmpeg.pid }); } catch (_) { }
      // cleanup metrics timer
      if (entry._metricsTimer) clearInterval(entry._metricsTimer);
    });

    // close handler
    ffmpeg.on('close', (code, signal) => {
      entry.dead = true;
      entry.stdinEnded = true;
      log('log', `[${nowTs()}][${entry.platform}] ffmpeg closed code=${code} signal=${signal} pid=${ffmpeg.pid}`);
      log('log', `[${nowTs()}][${entry.platform}] final stats:`, JSON.stringify(entry.stats));
      log('log', `[${nowTs()}][${entry.platform}] last stderr excerpt:`, stderrBuf.slice(-2000));
      if (streamPipes[roomId]) {
        streamPipes[roomId].ffmpegProcesses = streamPipes[roomId].ffmpegProcesses.filter(p => p !== entry);
      }
      emitStatus('idle');
      // emit final metrics
      emitMetrics();
      if (entry._metricsTimer) clearInterval(entry._metricsTimer);
    });

    // also listen for exit (some platforms emit exit)
    ffmpeg.on('exit', (code, signal) => {
      entry.dead = true;
      entry.stdinEnded = true;
      log('log', `[${nowTs()}][${entry.platform}] ffmpeg exit code=${code} signal=${signal} pid=${ffmpeg.pid}`);
      if (streamPipes[roomId]) {
        streamPipes[roomId].ffmpegProcesses = streamPipes[roomId].ffmpegProcesses.filter(p => p !== entry);
      }
      emitStatus('idle');
      if (entry._metricsTimer) clearInterval(entry._metricsTimer);
    });

    if (ffmpeg.stdin) {
      ffmpeg.stdin.on('error', (err) => {
        entry.dead = true;
        entry.stdinEnded = true;
        log('error', `[${nowTs()}][${entry.platform}] stdin error:`, err && (err.message || err));
        if (streamPipes[roomId]) streamPipes[roomId].ffmpegProcesses = streamPipes[roomId].ffmpegProcesses.filter(p => p !== entry);
        if (entry._metricsTimer) clearInterval(entry._metricsTimer);
      });
      ffmpeg.stdin.on('close', () => {
        entry.stdinEnded = true;
        log('log', `[${nowTs()}][${entry.platform}] stdin closed for pid=${ffmpeg.pid}`);
      });
    }

    // defensive: in case caller forgets to add entry to streamPipes, do it here
    if (!streamPipes[roomId]) streamPipes[roomId] = { ffmpegProcesses: [], buffer: [], pendingDestinations: [] };
    streamPipes[roomId].ffmpegProcesses.push(entry);

    // start periodic metrics emitter
    try {
      entry._metricsTimer = setInterval(() => {
        if (entry.dead) return;
        emitMetrics();
        // small log for heartbeat so you can tail logs and see it's alive
        log('log', `[${nowTs()}][${entry.platform}] heartbeat pid=${ffmpeg.pid} frames=${entry.stats.frames} fps=${entry.stats.fps} bytes=${entry.stats.bytes} backpressure=${entry.stats.backpressureEvents}`);
      }, metricsIntervalMs);
    } catch (e) {
      log('error', `[${nowTs()}][${entry.platform}] metrics timer error:`, e && e.message);
    }

    return entry;
  }
  function flushPendingDestinations(roomId) {
    const store = streamPipes[roomId];
    if (!store) return;
    const pending = store.pendingDestinations || [];
    if (!pending.length) return;

    console.log(`[rtmp] Flushing ${pending.length} pending destinations for room=${roomId}`);
    for (const pd of pending) {
      const { destination, rtmpUrl } = pd;
      // build ffmpeg args again or reuse logic — ensure rtmpUrl is passed into constructRtmpArgs if needed
      const ffmpegArgs = buildRtmpArgsForDestination(rtmpUrl); // you'll implement or reuse existing ffmpegArgs construct
      try {
        const procEntry = spawnSafeFFmpeg(ffmpegPath, ffmpegArgs, roomId, destination);
        // write header then buffer as above
        if (store.headerChunk) {
          procEntry.safeWrite(store.headerChunk);
          procEntry.wroteHeader = true;
        }
        store.buffer.forEach(chunk => procEntry.safeWrite(chunk));
      } catch (e) {
        console.error(`[rtmp] Failed to spawn pending for ${destination.platform}:`, e.message);
        io.to(roomId).emit('rtmp-stream-error', { success: false, message: `Failed pending ${destination.platform}: ${e.message}`, platform: destination.platform });
      }
    }
    // clear pending list
    store.pendingDestinations = [];
  }





  console.log(`User connected: ${socket.id}`);
  try {
    const { address } = socket.handshake;
    const origin = socket.handshake.headers?.origin;
    const ua = socket.handshake.headers?.['user-agent'];
    console.log(`[socket:connect] id=${socket.id} addr=${address} origin=${origin} ua=${ua}`);
  } catch (e) {
    console.log('[socket:connect] handshake meta unavailable');
  }

  // Join a room
  socket.on('join-room', (roomId, userId) => {
    socket.join(roomId);
    console.log(`User ${userId} joined room ${roomId}`);

    // Notify other users in the room
    socket.to(roomId).emit('user-connected', userId);

    // Handle when user disconnects
    socket.on('disconnect', () => {
      console.log(`User ${userId} disconnected`);
      socket.to(roomId).emit('user-disconnected', userId);
    });
  });

  // Signal handling for WebRTC - FIX HERE
  socket.on('signal', ({ userId, roomId, signal, targetUserId }) => {
    logger.info(`Signal from ${userId} to ${targetUserId || 'room'} in ${roomId}`);

    // If targetUserId is provided, send signal directly to that user
    if (targetUserId) {
      // Find the target user's socket and send the signal only to them
      const clients = io.sockets.adapter.rooms.get(roomId);
      if (clients) {
        for (const clientId of clients) {
          const clientSocket = io.sockets.sockets.get(clientId);
          if (clientSocket && clientSocket.userId === targetUserId) {
            clientSocket.emit('user-signal', { userId, signal });
            return;
          }
        }
      }
    }

    // Otherwise, send to all other users in the room (excluding sender)
    socket.to(roomId).emit('user-signal', { userId, signal });
  });

  // Store userId in socket object for later retrieval
  socket.on('register-user', ({ userId }) => {
    socket.userId = userId;
    console.log(`Registered socket ${socket.id} for user ${userId}`);
  });

  // Test RTMP stream with FFmpeg lavfi sources (color bars + sine tone)
  socket.on('test-rtmp-stream', async ({ roomId, platform, url, streamKey, duration }) => {
    try {
      const testDuration = Math.max(3, Math.min(Number(duration) || 10, 120));
      let rtmpUrl = constructRtmpUrl(platform, streamKey, url);
      const p = (platform || '').toLowerCase();
      io.to(roomId).emit('rtmp-platform-status', { platform, status: 'connecting' });
      console.log(`[test:${platform}] Spawning FFmpeg for ${testDuration}s to ${rtmpUrl.replace(streamKey, '****')}`);

      const args = [
        '-re',
        // video test source
        '-f', 'lavfi',
        '-i', `testsrc=size=1280x720:rate=30:duration=${testDuration}`,
        // audio test source
        '-f', 'lavfi',
        '-i', `sine=frequency=1000:sample_rate=44100:duration=${testDuration}`,
        // encoding
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'baseline',
        '-level', '3.1',
        '-g', '60',
        '-r', '30',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        // shorter keyint for faster start on ingest
        '-force_key_frames', 'expr:gte(t,n_forced*2)',
        // output
        '-f', 'flv',
        rtmpUrl
      ];

      const ff = spawn(ffmpegPath, args);
      let started = false;
      let stderrBuf = '';

      ff.stderr.on('data', (d) => {
        const out = d.toString();
        stderrBuf += out;
        // verbose logs help diagnose ingest
        console.log(`[test:${platform}] ffmpeg: ${out.trim()}`);
        if (!started && (out.includes('frame=') || out.includes('Stream mapping:'))) {
          started = true;
          io.to(roomId).emit('rtmp-platform-status', { platform, status: 'streaming' });
        }
        if (out.includes('Connection refused') ||
          out.includes('403 Forbidden') ||
          out.includes('401 Unauthorized') ||
          out.includes('Invalid') ||
          out.includes('timed out') ||
          out.includes('Failed to open') ||
          out.includes('Could not write header')) {
          io.to(roomId).emit('rtmp-platform-status', { platform, status: 'error', error: 'RTMP connection failed' });
          try { ff.kill('SIGTERM'); } catch { }
        }
      });

      ff.on('error', (e) => {
        console.error(`[test:${platform}] process error:`, e.message);
        io.to(roomId).emit('rtmp-platform-status', { platform, status: 'error', error: e.message });
      });

      ff.on('close', (code) => {
        console.log(`[test:${platform}] exited with code ${code}`);
        if (code === 0 || started) {
          io.to(roomId).emit('rtmp-platform-status', { platform, status: 'idle' });
        } else {
          io.to(roomId).emit('rtmp-platform-status', { platform, status: 'error', error: stderrBuf.slice(-400) || 'FFmpeg failed' });
        }
      });
    } catch (e) {
      console.error('[test-rtmp-stream] error:', e);
      socket.emit('rtmp-stream-error', { success: false, message: e.message, platform });
    }
  });

  // Add this to your Socket.io event handlers
  socket.on('get-host-id', async ({ roomId }) => {
    try {
      // Get the host ID for this room from the database
      const stream = await Stream.findOne({ roomId, active: true });

      if (stream) {
        socket.emit('host-id', stream.hostId);
      } else {
        console.log(`No active stream found for room ${roomId}`);
      }
    } catch (error) {
      console.error('Error getting host ID:', error);
    }
  });

  // Chat messaging
  socket.on('send-chat-message', (messageData) => {
    // Broadcast message to everyone in the room except sender
    socket.to(messageData.roomId).emit('chat-message', messageData);

    // Store chat messages in memory (optional - can be expanded to database)
    if (!chatMessages[messageData.roomId]) {
      chatMessages[messageData.roomId] = [];
    }

    // Keep only last 100 messages per room
    chatMessages[messageData.roomId].push(messageData);
    if (chatMessages[messageData.roomId].length > 100) {
      chatMessages[messageData.roomId].shift();
    }
  });

  // Send chat history when user joins room
  socket.on('get-chat-history', ({ roomId }) => {
    if (chatMessages[roomId]) {
      socket.emit('chat-history', chatMessages[roomId]);
    }
  });

  // Message reactions
  socket.on('add-reaction', (reactionData) => {
    socket.to(reactionData.roomId).emit('message-reaction', reactionData);
  });

  // Message deletion
  socket.on('delete-message', ({ messageId, roomId, userId }) => {
    // Optionally verify that the user is allowed to delete this message
    // For example, check if user is host or message author

    // If using DB storage, delete from database here

    // Notify all clients about deleted message
    io.to(roomId).emit('message-deleted', messageId);

    // Update in-memory storage if using
    if (chatMessages[roomId]) {
      chatMessages[roomId] = chatMessages[roomId].filter(msg => msg.id !== messageId);
    }
  });

  // User muting
  socket.on('mute-user', async ({ roomId, userId, targetUserId, targetUsername }) => {
    // Check if requester is the host
    const stream = await Stream.findOne({ roomId, hostId: userId });
    if (stream) {
      // Store muted user in a set or database
      if (!mutedUsers[roomId]) {
        mutedUsers[roomId] = new Set();
      }
      mutedUsers[roomId].add(targetUserId);

      // Optional: Broadcast to all moderators that user was muted
      // This could be used to sync mute state across host devices
      socket.to(roomId).emit('user-muted', { targetUserId, targetUsername });
    }
  });

  // start-rtmp-stream
  socket.on('start-rtmp-stream', async ({ roomId, userId, destinations }) => {
    try {
      console.log(`\n=== Starting RTMP Stream ===`);
      console.log(`Room: ${roomId}`);
      console.log(`User: ${userId}`);
      console.log(`Destinations:`, destinations);
      console.log(`[ffmpeg] binary: ${ffmpegPath}`);

      // Validate
      if (!destinations || destinations.length === 0) {
        socket.emit('rtmp-stream-error', {
          success: false,
          message: 'No streaming destinations provided'
        });
        return;
      }

      // Initialize stream pipe storage for this room
      if (!streamPipes[roomId]) {
        streamPipes[roomId] = {
          ffmpegProcesses: [],
          buffer: []
        };
      }

      let successCount = 0;

      // Ensure room storage exists
      if (!streamPipes[roomId]) {
        streamPipes[roomId] = { ffmpegProcesses: [], buffer: [] };
      }
      // If we don't yet have an EBML header, defer FFmpeg spawn until header arrives
      const deferUntilHeader = !streamPipes[roomId].headerChunk;
      if (deferUntilHeader) {
        console.log(`[rtmp] Deferring FFmpeg start until EBML header is captured for room=${roomId}`);
        if (!streamPipes[roomId].pendingDestinations) {
          streamPipes[roomId].pendingDestinations = [];
        }
      }

      // Process each destination
      for (const destination of destinations) {
        if (!destination.streamKey || !destination.streamKey.trim()) {
          console.error(`Missing stream key for ${destination.platform}`);
          socket.emit('rtmp-stream-error', {
            success: false,
            message: `Missing stream key for ${destination.platform}`,
            platform: destination.platform
          });
          continue;
        }

        // Construct RTMP URL
        let rtmpUrl = constructRtmpUrl(destination.platform?.toLowerCase(), destination.streamKey, destination.url);
        console.log(rtmpUrl, "<<<<<<<<<<<<<<<<<<<<<<<<");
        // If deferring, queue destination and continue
        if (deferUntilHeader) {
          streamPipes[roomId].pendingDestinations.push({
            destination,
            rtmpUrl
          });
          io.to(roomId).emit('rtmp-platform-status', {
            platform: destination.platform,
            status: 'connecting'
          });
          continue;
        }

        const ffmpegArgs = buildRtmpArgsForDestination(rtmpUrl);
        try {
          console.log(`[${destination.platform}] Starting FFmpeg...`);
          console.log(`[${destination.platform}] Output: ${rtmpUrl.replace(destination.streamKey, '****')}`);

          // spawn and get the proc entry
          const procEntry = spawnSafeFFmpeg(ffmpegPath, ffmpegArgs, roomId, destination);
          successCount++;

          // If there's a preserved EBML header, write it first using procEntry.safeWrite
          if (streamPipes[roomId].headerChunk && !procEntry.wroteHeader) {
            try {
              if (procEntry.stdin && !procEntry.stdinEnded) {
                const ok = procEntry.safeWrite(streamPipes[roomId].headerChunk);
                if (ok) {
                  procEntry.wroteHeader = true;
                  console.log(`[${destination.platform}] Wrote preserved EBML header chunk to pid=${procEntry.process.pid}`);
                } else {
                  console.warn(`[${destination.platform}] backpressure while writing header to pid=${procEntry.process.pid}`);
                }
              }
            } catch (e) {
              console.error(`[${destination.platform}] Failed writing EBML header to stdin:`, e.message);
            }
          }

          // Now flush any buffered chunks
          if (Array.isArray(streamPipes[roomId].buffer) && streamPipes[roomId].buffer.length > 0) {
            console.log(`[${destination.platform}] Writing ${streamPipes[roomId].buffer.length} buffered chunks to pid=${procEntry.process.pid}`);
            for (const chunk of streamPipes[roomId].buffer) {
              if (procEntry.stdin && !procEntry.stdinEnded) {
                const ok = procEntry.safeWrite(chunk);
                if (!ok) {
                  // if backpressure, you can choose to break or keep trying; we log and continue
                  console.warn(`[${destination.platform}] backpressure while writing buffered chunk pid=${procEntry.process.pid}`);
                }
              } else {
                console.warn(`[${destination.platform}] cannot write chunk, stdin ended or missing for pid=${procEntry.process.pid}`);
              }
            }
          }

        } catch (error) {
          console.error(`[${destination.platform}] Failed to spawn FFmpeg:`, error);
          socket.emit('rtmp-stream-error', {
            success: false,
            message: `Failed to start ${destination.platform}: ${error.message}`,
            platform: destination.platform
          });
        }

      }

      // If we deferred starts, report success while waiting for header
      if (deferUntilHeader && (streamPipes[roomId].pendingDestinations?.length || 0) > 0) {
        socket.emit('rtmp-stream-started', {
          success: true,
          message: `Streams queued. Waiting for video header...`,
          destinations: (destinations || []).map(d => d.platform)
        });
        // Ask the room to resend a fresh WebM header (host will restart MediaRecorder)
        try {
          io.to(roomId).emit('request-media-header', { roomId });
          console.log(`[rtmp] Requested media header resend for room=${roomId}`);
        } catch (e) {
          console.error('[rtmp] Failed to emit request-media-header:', e.message);
        }
      } else if (successCount > 0) {
        socket.emit('rtmp-stream-started', {
          success: true,
          message: `Started ${successCount} stream${successCount > 1 ? 's' : ''}. Waiting for video data...`,
          destinations: destinations.map(d => d.platform)
        });
      } else {
        socket.emit('rtmp-stream-error', {
          success: false,
          message: 'Failed to start any streams'
        });
      }

    } catch (error) {
      console.error('Error in start-rtmp-stream:', error);
      socket.emit('rtmp-stream-error', {
        success: false,
        message: `Server error: ${error.message}`
      });
    }
  });

  socket.on('stream-data', ({ roomId, data, isHeader }) => {
    console.log("inside stream ------------------ data");
    if (!streamPipes[roomId] || !Array.isArray(streamPipes[roomId].ffmpegProcesses)) {
      streamPipes[roomId] = streamPipes[roomId] || { ffmpegProcesses: [], buffer: [], pendingDestinations: [] };
    }

    // convertToBuffer should return a Buffer
    const buffer = convertToBuffer(data);
    if (!buffer) return;

    // header detection (isHeader explicitly set OR EBML magic found)
    if (isHeader || (!streamPipes[roomId].headerChunk && detectEbmlHeader(buffer))) {
      streamPipes[roomId].headerChunk = isHeader ? Buffer.from(buffer) : Buffer.from(buffer.slice(headerPos || 0));
      // try to start pending destinations (they will get header + buffered chunks)
      startPendingForRoom(roomId);
      return;
    }

    // fallback manual search for EBML magic (if detectEbmlHeader isn't reliable)
    if (!streamPipes[roomId].headerChunk && buffer.length >= 4) {
      const MAGIC = [0x1A, 0x45, 0xDF, 0xA3];
      let pos = -1;
      const searchLimit = Math.min(buffer.length - 4, 8192);
      for (let i = 0; i <= searchLimit; i++) {
        if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) {
          pos = i;
          break;
        }
      }
      if (pos >= 0) {
        streamPipes[roomId].headerChunk = Buffer.from(buffer.slice(pos));

        // Start pending FFmpeg processes safely
        const pending = streamPipes[roomId].pendingDestinations || [];
        if (pending.length > 0) {
          flushPendingDestinations(roomId);
        }
      }
    }

    // stats init
    if (!streamPipes[roomId].stats) {
      streamPipes[roomId].stats = { chunkCount: 0, totalBytes: 0, lastLogAt: Date.now() };
    }
    const stats = streamPipes[roomId].stats;
    stats.chunkCount += 1;
    stats.totalBytes += buffer.length;
    if (stats.chunkCount % 50 === 0) {
      const elapsedMs = Date.now() - stats.lastLogAt;
      const kb = (stats.totalBytes / 1024).toFixed(1);
      const rateKbps = elapsedMs > 0 ? ((stats.totalBytes * 8) / 1000) / (elapsedMs / 1000) : 0;
      stats.lastLogAt = Date.now();
      stats.totalBytes = 0;
    }

    // write chunk to each ffmpeg process defensively
    // inside stream-data, replace the procs.forEach(...) block with:

    const procs = streamPipes[roomId].ffmpegProcesses || [];
    procs.forEach((proc) => {
      const stdin = proc.stdin;
      const platform = proc.platform || 'unknown';
      const child = proc.process;
      const pStats = proc.stats;

      // New: consider stream finished if any of these flags are set
      const stdinEnded = proc.stdinEnded || (stdin && (stdin.writableEnded || stdin.writableFinished));
      const childDead = !child || child.killed;

      // defensive guard: ensure stdin exists and is writable and not finished
      const canWrite = stdin && !stdin.destroyed && stdin.writable && !stdinEnded && !childDead;
      if (!canWrite) {
        // Optionally: remove the proc from array to keep list clean
        // (do NOT mutate while iterating — mark for cleanup)
        proc._shouldRemove = true;
        return;
      }

      // ensure we attach handlers once to avoid uncaught errors
      if (!proc._handlersAttached) {
        proc._handlersAttached = true;

        // when stdin errors (including write after end), mark and log
        stdin.on('error', (err) => {
          console.warn(`[${platform}] stdin error:`, err && err.message);
          proc.stdinEnded = true;
        });

        // when child dies, avoid future writes
        child.on('exit', (code, sig) => {
          console.log(`[${platform}] ffmpeg exit code=${code} sig=${sig}`);
          proc.stdinEnded = true;
          proc._exited = true;
        });

        child.on('error', (err) => {
          console.error(`[${platform}] child error:`, err && err.message);
          proc.stdinEnded = true;
        });

        // also watch stdout/stderr for debugging
        if (child.stdout) child.stdout.on('data', d => {/* optionally log trimmed d */ });
        if (child.stderr) child.stderr.on('data', d => {/* optionally log trimmed d */ });
      }

      try {
        // header injection: ensure header is present once per proc
        if (!proc.wroteHeader && streamPipes[roomId].headerChunk) {
          try {
            if (stdin && stdin.writable && !stdin.destroyed && !proc.stdinEnded) {
              stdin.write(streamPipes[roomId].headerChunk);
              proc.wroteHeader = true;
              console.log(`[write:${platform}] header injected`);
            }
          } catch (e) {
            console.error(`[${platform}] Error injecting header:`, e && e.message);
            proc.stdinEnded = true;
            return;
          }
        }

        // final guard before actual write
        if (stdin.writable && !stdin.destroyed && !proc.stdinEnded) {
          const ok = stdin.write(buffer);
          if (pStats) {
            pStats.chunks = (pStats.chunks || 0) + 1;
            pStats.bytes = (pStats.bytes || 0) + buffer.length;
            if (pStats.chunks % 50 === 0) {
              const elapsedMs = Date.now() - pStats.lastLogAt;
              const kb = (pStats.bytes / 1024).toFixed(1);
              console.log(`[write:${platform}] chunks=${pStats.chunks} bytes=${pStats.bytes} (${kb} KB) elapsed=${elapsedMs}ms backpressure=${ok === false}`);
              pStats.lastLogAt = Date.now();
              pStats.bytes = 0;
            }
          }

          if (ok === false) {
            stdin.once('drain', () => {
              console.log(`[write:${platform}] drain event`);
            });
          }
        }
      } catch (err) {
        console.error(`[${platform}] Error writing to FFmpeg stdin:`, err && err.message);
        proc.stdinEnded = true;
      }
    });

    // cleanup removed procs after iteration (safe to mutate)
    streamPipes[roomId].ffmpegProcesses = (streamPipes[roomId].ffmpegProcesses || []).filter(p => !p._shouldRemove && !p._exited);


    // Keep a small ring buffer for newly started processes
    streamPipes[roomId].buffer.push(buffer);
    if (streamPipes[roomId].buffer.length > 20) {
      streamPipes[roomId].buffer.shift(); // Keep only last 20 chunks
    }

  });


  //Handle stop streaming
  socket.on('stop-rtmp-stream', ({ roomId, platform }) => {
    console.log(`[stop-rtmp-stream] room=${roomId} platform=${platform || 'ALL'}`);
    if (!streamPipes[roomId]) {
      socket.emit('rtmp-stream-error', {
        success: false,
        message: 'No active streams for this room'
      });
      return;
    }

    if (platform) {
      // Stop specific platform
      const proc = streamPipes[roomId].ffmpegProcesses.find(p => p.platform === platform);
      if (proc) {
        console.log(`[stop-rtmp-stream] stopping platform=${platform}`);
        proc.stdin.end();
        proc.process.kill('SIGTERM');
        streamPipes[roomId].ffmpegProcesses =
          streamPipes[roomId].ffmpegProcesses.filter(p => p.platform !== platform);

        socket.emit('rtmp-stream-stopped', {
          success: true,
          platform: platform
        });
      }
    } else {
      // Stop all streams for this room
      console.log(`[stop-rtmp-stream] stopping all platforms count=${streamPipes[roomId].ffmpegProcesses.length}`);
      streamPipes[roomId].ffmpegProcesses.forEach(({ stdin, process }) => {
        stdin.end();
        process.kill('SIGTERM');
      });
      delete streamPipes[roomId];

      socket.emit('rtmp-stream-stopped', {
        success: true,
        message: 'All streams stopped'
      });
    }
  });

  // Handle cleanup on disconnect
  socket.on('disconnect', () => {
    if (socket.ffmpegProcesses && socket.ffmpegProcesses.length > 0) {
      console.log(`Cleaning up ${socket.ffmpegProcesses.length} FFmpeg processes`);
      socket.ffmpegProcesses.forEach(({ process, platform }) => {
        try {
          process.kill('SIGTERM');
          console.log(`Terminated FFmpeg process for ${platform}`);
        } catch (err) {
          console.error(`Error terminating FFmpeg process for ${platform}:`, err);
        }
      });
    }
  });

  // Add this to your socket.io event handlers
  socket.on('get-external-streaming-status', async ({ roomId }) => {
    try {
      const stream = await Stream.findOne({ roomId, active: true });

      if (stream) {
        // Get active platforms from streamPipes registry
        const activePlatforms = (streamPipes[roomId]?.ffmpegProcesses || []).map(p => p.platform);

        // Send status to client
        socket.emit('external-streaming-status', {
          active: activePlatforms.length > 0,
          platforms: activePlatforms
        });
      } else {
        socket.emit('external-streaming-status', {
          active: false,
          platforms: []
        });
      }
    } catch (error) {
      console.error('Error getting external streaming status:', error);
      socket.emit('external-streaming-status', {
        active: false,
        platforms: [],
        error: error.message
      });
    }
  });
});

// Clean up FFmpeg processes on server shutdown
process.on('SIGINT', () => {
  console.log('Shutting down, cleaning up FFmpeg processes...');
  try {
    Object.keys(streamPipes).forEach(roomId => {
      (streamPipes[roomId]?.ffmpegProcesses || []).forEach(({ process, platform }) => {
        try {
          process.kill('SIGTERM');
          console.log(`Terminated FFmpeg process for ${platform} in room ${roomId}`);
        } catch (e) {
          console.error(`Error terminating FFmpeg for ${platform} in room ${roomId}:`, e.message);
        }
      });
    });
  } catch (e) {
    console.error('Error during shutdown cleanup:', e.message);
  }
  process.exit(0);
});

// API Routes
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).send('Internal Server Error');
});