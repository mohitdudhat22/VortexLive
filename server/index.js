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
  } else {
    console.log('[ffmpeg] OK:', (probe.stdout || '').split('\n')[0]);
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

// In-memory storage for active FFmpeg processes
const ffmpegProcesses = {};

// Store active stream pipes per room
const streamPipes = {};
// Socket.io logic for handling WebRTC signaling
io.on('connection', (socket) => {
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
      let rtmpUrl = '';
      const p = (platform || '').toLowerCase();
      if (p === 'youtube') {
        rtmpUrl = `rtmps://a.rtmp.youtube.com:443/live2/${streamKey}`;
      } else if (p === 'facebook') {
        rtmpUrl = `rtmps://live-api-s.facebook.com:443/rtmp/${streamKey}`;
      } else if (p === 'twitch') {
        rtmpUrl = `rtmp://live.twitch.tv/app/${streamKey}`;
      } else if (url && streamKey) {
        rtmpUrl = `${url}/${streamKey}`;
      } else {
        socket.emit('rtmp-platform-status', { platform, status: 'error', error: 'Invalid RTMP target' });
        return;
      }
      
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
          try { ff.kill('SIGTERM'); } catch {}
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

// Replace your 'start-rtmp-stream' socket handler with this enhanced version:


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
      let rtmpUrl = '';
      switch (destination.platform?.toLowerCase()) {
        case 'youtube':
          // Prefer RTMPS for YouTube for better compatibility/firewall traversal
          rtmpUrl = `rtmps://a.rtmp.youtube.com:443/live2/${destination.streamKey}`;
          break;
        case 'facebook':
          rtmpUrl = `rtmps://live-api-s.facebook.com:443/rtmp/${destination.streamKey}`;
          break;
        case 'twitch':
          rtmpUrl = `rtmp://live.twitch.tv/app/${destination.streamKey}`;
          break;
        case 'custom':
          if (!destination.url || !destination.url.trim()) {
            socket.emit('rtmp-stream-error', { 
              success: false, 
              message: 'Custom RTMP URL is required',
              platform: destination.platform
            });
            continue;
          }
          rtmpUrl = `${destination.url}/${destination.streamKey}`;
          break;
        default:
          rtmpUrl = `${destination.url}/${destination.streamKey}`;
      }
      
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
      
      console.log(`[${destination.platform}] Starting FFmpeg...`);
      console.log(`[${destination.platform}] Output: ${rtmpUrl.replace(destination.streamKey, '****')}`);
      
      // FFmpeg arguments - reading from stdin
      const ffmpegArgs = [
        // Input options for chunked webm from MediaRecorder over stdin
        '-re',                       // Read at native frame rate
        '-fflags', '+genpts+discardcorrupt', // Generate missing PTS, tolerate minor corruption
        '-use_wallclock_as_timestamps', '1',
        '-thread_queue_size', '1024',
        '-probesize', '10M',
        '-analyzeduration', '10M',
        '-f', 'webm',           // Input format
        '-i', 'pipe:0',         // Read from stdin
        '-c:v', 'libx264',      // Video codec
        '-preset', 'veryfast',  // Encoding speed
        '-maxrate', '3000k',
        '-bufsize', '6000k',
        '-pix_fmt', 'yuv420p',  // Pixel format
        '-g', '60',             // GOP size
        '-keyint_min', '60',    // Consistent keyframe interval
        '-force_key_frames', 'expr:gte(t,n_forced*2)', // Faster initial keyframes
        '-r', '30',             // Frame rate
        '-c:a', 'aac',          // Audio codec
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',             // Stereo
        '-flush_packets', '1',
        '-f', 'flv',            // Output format
        rtmpUrl
      ];
      console.log(`[${destination.platform}] FFmpeg args: ${ffmpegArgs.join(' ')}`);
      
      try {
        const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
        
        let isStreaming = false;
        let errorOutput = '';
        
        // Handle stdout
        ffmpeg.stdout.on('data', (data) => {
          console.log(`[${destination.platform}] stdout:`, data.toString());
        });
        
        // Handle stderr (FFmpeg outputs logs here)
        ffmpeg.stderr.on('data', (data) => {
          const output = data.toString();
          errorOutput += output;
          // TEMP: verbose log to diagnose ingest
          console.log(`[${destination.platform}] ffmpeg: ${output.trim()}`);
          //
          // Check if streaming started successfully
          if ((output.includes('Stream mapping:') || output.includes('frame=')) && !isStreaming) {
            isStreaming = true;
            console.log(`[${destination.platform}] ✓ Streaming started!`);
            
            io.to(roomId).emit('rtmp-platform-status', {
              platform: destination.platform,
              status: 'streaming'
            });
          }
          
          // Check for errors
          if (output.includes('Connection refused') || 
              output.includes('403 Forbidden') ||
              output.includes('401 Unauthorized') ||
              output.includes('Invalid') ||
              output.includes('failed')) {
            
            console.error(`[${destination.platform}] ✗ Error detected`);
            
            io.to(roomId).emit('rtmp-platform-status', {
              platform: destination.platform,
              status: 'error',
              error: 'Connection failed. Check your stream key.'
            });
            
            // Kill the process
            ffmpeg.kill('SIGTERM');
          }
        });
        
        // Handle errors
        ffmpeg.on('error', (error) => {
          console.error(`[${destination.platform}] Process error:`, error.message);
          
          io.to(roomId).emit('rtmp-stream-error', { 
            success: false, 
            message: `${destination.platform} failed: ${error.message}`,
            platform: destination.platform
          });
        });
        
        // Handle process exit
        ffmpeg.on('close', (code) => {
          console.log(`[${destination.platform}] Process exited with code ${code}`);
          
          if (code !== 0) {
            console.error(`[${destination.platform}] Last error:`, errorOutput.slice(-500));
          }
          
          // Remove from active processes
          if (streamPipes[roomId]) {
            streamPipes[roomId].ffmpegProcesses = 
              streamPipes[roomId].ffmpegProcesses.filter(p => p.process !== ffmpeg);
          }
          
          io.to(roomId).emit('rtmp-platform-status', {
            platform: destination.platform,
            status: 'idle'
          });
        });
        
        // Store the process
        streamPipes[roomId].ffmpegProcesses.push({
          process: ffmpeg,
          stdin: ffmpeg.stdin,
          platform: destination.platform,
          stats: { chunks: 0, bytes: 0, lastLogAt: Date.now() },
          wroteHeader: false
        });
        
        successCount++;
        
        // If there's buffered data, write it now
        if (streamPipes[roomId].buffer.length > 0) {
          console.log(`[${destination.platform}] Writing ${streamPipes[roomId].buffer.length} buffered chunks`);
          // Ensure EBML header is written first if we captured it
          if (streamPipes[roomId].headerChunk && !streamPipes[roomId].ffmpegProcesses.find(p => p.process === ffmpeg)?.wroteHeader) {
            try {
              if (ffmpeg.stdin.writable) {
                ffmpeg.stdin.write(streamPipes[roomId].headerChunk);
                console.log(`[${destination.platform}] Wrote preserved EBML header chunk`);
                const procEntry = streamPipes[roomId].ffmpegProcesses.find(p => p.process === ffmpeg);
                if (procEntry) procEntry.wroteHeader = true;
              }
            } catch (e) {
              console.error(`[${destination.platform}] Failed writing EBML header to stdin:`, e.message);
            }
          }
          streamPipes[roomId].buffer.forEach(chunk => {
            if (ffmpeg.stdin.writable) {
              ffmpeg.stdin.write(chunk);
            }
          });
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


// NEW: Handle incoming video chunks from frontend
socket.on('stream-data', ({ roomId, data }) => {  
  if (!streamPipes[roomId] || !streamPipes[roomId].ffmpegProcesses.length) {
    // console.warn(`Received stream data for ${roomId} but no active FFmpeg processes`);
    // Still collect header and buffer even if no active processes yet
    if (!streamPipes[roomId]) {
      streamPipes[roomId] = { ffmpegProcesses: [], buffer: [] };
    }
  }

  // Convert incoming payload to Buffer:
  // - Buffer (already)
  // - ArrayBuffer (from socket.io binary) -> Buffer.from(arrayBuffer)
  // - TypedArray (e.g., Uint8Array) -> Buffer.from(view.buffer, offset, length)
  // - base64 string (legacy) -> Buffer.from(str, 'base64')
  let buffer;
  try {
    if (Buffer.isBuffer(data)) {
      buffer = data;
    } else if (data instanceof ArrayBuffer) {
      buffer = Buffer.from(data);
    } else if (typeof data?.buffer === 'object' && data?.byteLength !== undefined) {
      // Likely a TypedArray/DataView
      buffer = Buffer.from(data.buffer, data.byteOffset || 0, data.byteLength);
    } else if (typeof data === 'string') {
      buffer = Buffer.from(data, 'base64');
    } else {
      console.warn('[stream-data] Unsupported data type received:', typeof data);
      return;
    }
  } catch (e) {
    console.error('[stream-data] Failed to convert incoming data to Buffer:', e.message);
    return;
  }
  // Detect and store EBML header chunk once (search within first few KB)
  if (!streamPipes[roomId].headerChunk && buffer && buffer.length >= 4) {
    const MAGIC = [0x1A, 0x45, 0xDF, 0xA3];
    let pos = -1;
    const searchLimit = Math.min(buffer.length - 4, 8192);
    for (let i = 0; i <= searchLimit; i++) {
      if (buffer[i] === MAGIC[0] && buffer[i+1] === MAGIC[1] && buffer[i+2] === MAGIC[2] && buffer[i+3] === MAGIC[3]) {
        pos = i;
        break;
      }
    }
    if (pos >= 0) {
      // Store header from magic onward
      streamPipes[roomId].headerChunk = Buffer.from(buffer.slice(pos));
      console.log(`[stream-data] Captured EBML header at offset ${pos} for room=${roomId}`);
      
      // If there are pending destinations waiting for header, start them now
      const pending = streamPipes[roomId].pendingDestinations || [];
      if (pending.length > 0) {
        console.log(`[stream-data] Starting ${pending.length} pending FFmpeg processes for room=${roomId}`);
        pending.forEach(pend => {
          const { destination, rtmpUrl } = pend;
          try {
            console.log(`[${destination.platform}] Starting FFmpeg (deferred)...`);
            console.log(`[${destination.platform}] Output: ${rtmpUrl.replace(destination.streamKey, '****')}`);
            const ffmpegArgs = [
              '-re',
              '-fflags', '+genpts+discardcorrupt',
              '-use_wallclock_as_timestamps', '1',
              '-thread_queue_size', '1024',
              '-probesize', '10M',
              '-analyzeduration', '10M',
              '-f', 'webm',
              '-i', 'pipe:0',
              '-c:v', 'libx264',
              '-preset', 'veryfast',
              '-maxrate', '3000k',
              '-bufsize', '6000k',
              '-pix_fmt', 'yuv420p',
              '-g', '60',
              '-keyint_min', '60',
              '-force_key_frames', 'expr:gte(t,n_forced*2)',
              '-r', '30',
              '-c:a', 'aac',
              '-b:a', '128k',
              '-ar', '44100',
              '-ac', '2',
              '-flush_packets', '1',
              '-f', 'flv',
              rtmpUrl
            ];
            const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
            let isStreaming = false;
            let errorOutput = '';
            ffmpeg.stdout.on('data', (d) => console.log(`[${destination.platform}] stdout:`, d.toString()));
            ffmpeg.stderr.on('data', (d) => {
              const out = d.toString();
              errorOutput += out;
              console.log(`[${destination.platform}] ffmpeg: ${out.trim()}`);
              if ((out.includes('Stream mapping:') || out.includes('frame=')) && !isStreaming) {
                isStreaming = true;
                console.log(`[${destination.platform}] ✓ Streaming started!`);
                io.to(roomId).emit('rtmp-platform-status', { platform: destination.platform, status: 'streaming' });
              }
              if (out.includes('Connection refused') ||
                  out.includes('403 Forbidden') ||
                  out.includes('401 Unauthorized') ||
                  out.includes('Invalid') ||
                  out.includes('failed') ||
                  out.includes('Invalid data found when processing input')) {
                console.error(`[${destination.platform}] ✗ Error detected`);
                io.to(roomId).emit('rtmp-platform-status', {
                  platform: destination.platform,
                  status: 'error',
                  error: 'Connection or input failed. Check your stream key.'
                });
                ffmpeg.kill('SIGTERM');
              }
            });
            ffmpeg.on('error', (e) => {
              console.error(`[${destination.platform}] Process error:`, e.message);
              io.to(roomId).emit('rtmp-stream-error', { success: false, message: `${destination.platform} failed: ${e.message}`, platform: destination.platform });
            });
            ffmpeg.on('close', (code) => {
              console.log(`[${destination.platform}] Process exited with code ${code}`);
              if (code !== 0) console.error(`[${destination.platform}] Last error:`, errorOutput.slice(-500));
              if (streamPipes[roomId]) {
                streamPipes[roomId].ffmpegProcesses =
                  streamPipes[roomId].ffmpegProcesses.filter(p => p.process !== ffmpeg);
              }
              io.to(roomId).emit('rtmp-platform-status', { platform: destination.platform, status: 'idle' });
            });
            streamPipes[roomId].ffmpegProcesses.push({
              process: ffmpeg,
              stdin: ffmpeg.stdin,
              platform: destination.platform,
              stats: { chunks: 0, bytes: 0, lastLogAt: Date.now() },
              wroteHeader: false
            });
            // Write the captured header first
            try {
              if (ffmpeg.stdin.writable && streamPipes[roomId].headerChunk) {
                ffmpeg.stdin.write(streamPipes[roomId].headerChunk);
                const procEntry = streamPipes[roomId].ffmpegProcesses.find(p => p.process === ffmpeg);
                if (procEntry) procEntry.wroteHeader = true;
              }
            } catch (e) {
              console.error(`[${destination.platform}] Failed writing EBML header to stdin:`, e.message);
            }
            // Then write any buffered chunks
            (streamPipes[roomId].buffer || []).forEach(chunk => {
              if (ffmpeg.stdin.writable) {
                ffmpeg.stdin.write(chunk);
              }
            });
          } catch (e) {
            console.error(`[${destination.platform}] Failed to spawn FFmpeg (deferred):`, e);
            io.to(roomId).emit('rtmp-stream-error', { success: false, message: `Failed to start ${destination.platform}: ${e.message}`, platform: destination.platform });
          }
        });
        // Clear pending after starting
        streamPipes[roomId].pendingDestinations = [];
      }
    }
  }
  
  // Stats per room for debugging throughput
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
    console.log(`[stream-data] room=${roomId} chunks=${stats.chunkCount} bytes=${stats.totalBytes} (${kb} KB) rate≈${rateKbps.toFixed(1)} kbps activeFFmpeg=${streamPipes[roomId].ffmpegProcesses.length}`);
    stats.lastLogAt = Date.now();
    stats.totalBytes = 0;
  }
  
  // Write to all active FFmpeg processes for this room
  streamPipes[roomId].ffmpegProcesses.forEach((proc) => {
    const { stdin, platform, process, stats: pStats } = proc;
    if (stdin && stdin.writable && !process.killed) {
      try {
        // Ensure header is written once per process before media data
        if (!proc.wroteHeader && streamPipes[roomId].headerChunk) {
          try {
            stdin.write(streamPipes[roomId].headerChunk);
            proc.wroteHeader = true;
            console.log(`[write:${platform}] header injected`);
          } catch (e) {
            console.error(`[${platform}] Error injecting header:`, e.message);
          }
        }
        const ok = stdin.write(buffer);
        if (pStats) {
          pStats.chunks += 1;
          pStats.bytes += buffer.length;
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
      } catch (err) {
        console.error(`[${platform}] Error writing to FFmpeg stdin:`, err.message);
      }
    }
  });
  
  // Keep a small buffer for newly started processes
  streamPipes[roomId].buffer.push(buffer);
  if (streamPipes[roomId].buffer.length > 20) {
    streamPipes[roomId].buffer.shift(); // Keep only last 20 chunks
  }
});

// NEW: Handle stop streaming
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

// socket.on('stream-data', ({ roomId, data }) => {
//   if (!streamPipes[roomId] || !streamPipes[roomId].ffmpegProcesses.length) {
//     // console.warn(`Received stream data for ${roomId} but no active FFmpeg processes`);
//     return;
//   }
  
//   try {
//     // Convert base64 to buffer
//     const buffer = Buffer.from(data, 'base64');
    
//     // Write to all active FFmpeg processes for this room
//     let successCount = 0;
//     streamPipes[roomId].ffmpegProcesses.forEach(({ stdin, platform, process }) => {
//       if (stdin && stdin.writable && !process.killed) {
//         try {
//           stdin.write(buffer);
//           successCount++;
//         } catch (err) {
//           console.error(`[${platform}] Error writing to stdin:`, err.message);
//         }
//       }
//     });
    
//     // Keep a small buffer for newly started processes (last 5 chunks)
//     streamPipes[roomId].buffer.push(buffer);
//     if (streamPipes[roomId].buffer.length > 5) {
//       streamPipes[roomId].buffer.shift();
//     }
    
//   } catch (error) {
//     console.error('Error processing stream data:', error);
//   }
// });

//   socket.on('stop-rtmp-stream', ({ roomId, platform }) => {
//   console.log(`Stopping RTMP stream for room ${roomId}${platform ? ` (${platform})` : ''}`);
  
//   if (!streamPipes[roomId]) {
//     socket.emit('rtmp-stream-error', {
//       success: false,
//       message: 'No active streams for this room'
//     });
//     return;
//   }
  
//   try {
//     if (platform) {
//       // Stop specific platform
//       const proc = streamPipes[roomId].ffmpegProcesses.find(p => p.platform === platform);
//       if (proc) {
//         console.log(`Stopping ${platform} stream...`);
//         proc.stdin.end();
//         proc.process.kill('SIGTERM');
        
//         streamPipes[roomId].ffmpegProcesses = 
//           streamPipes[roomId].ffmpegProcesses.filter(p => p.platform !== platform);
        
//         io.to(roomId).emit('rtmp-platform-status', {
//           platform: platform,
//           status: 'idle'
//         });
        
//         socket.emit('rtmp-stream-stopped', {
//           success: true,
//           platform: platform,
//           message: `${platform} stream stopped`
//         });
//       }
//     } else {
//       // Stop all streams for this room
//       console.log(`Stopping all streams for room ${roomId}...`);
      
//       streamPipes[roomId].ffmpegProcesses.forEach(({ stdin, process, platform }) => {
//         try {
//           stdin.end();
//           process.kill('SIGTERM');
//           console.log(`Stopped ${platform}`);
//         } catch (err) {
//           console.error(`Error stopping ${platform}:`, err);
//         }
//       });
      
//       delete streamPipes[roomId];
      
//       socket.emit('rtmp-stream-stopped', {
//         success: true,
//         message: 'All streams stopped'
//       });
//     }
//   } catch (error) {
//     console.error('Error stopping streams:', error);
//     socket.emit('rtmp-stream-error', {
//       success: false,
//       message: 'Error stopping streams: ' + error.message
//     });
//   }
// });
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

// FFmpeg helper functions
async function startRtmpStreams(roomId, destinations) {
  const PORT = process.env.PORT || 5000;
  
  if (!ffmpegProcesses[roomId]) {
    ffmpegProcesses[roomId] = {};
  }
  
  const activeStreams = [];
  
  for (const dest of destinations) {
    try {
      // Make sure we have the required data
      if (!dest.platform || !dest.streamKey || !dest.url) {
        console.error(`Missing required data for ${dest.platform} stream`);
        continue;
      }
      
      // Different platforms might need different FFmpeg parameters
      const inputSource = `http://localhost:${PORT}/api/streams/${roomId}/source`;
      let rtmpUrl = '';
      
      switch (dest.platform) {
        case 'youtube':
          rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${dest.streamKey}`;
          break;
        case 'facebook':
          rtmpUrl = `rtmp://live-api-s.facebook.com:80/rtmp/${dest.streamKey}`;
          break;
        case 'twitch':
          rtmpUrl = `rtmp://live.twitch.tv/app/${dest.streamKey}`;
          break;
        default:
          rtmpUrl = dest.url;
      }
      
      // Update clients that we're connecting
      io.to(roomId).emit('rtmp-platform-status', {
        platform: dest.platform,
        status: 'connecting'
      });
      
      // Use ffmpegPath instead of 'ffmpeg'
      console.log(`Using FFmpeg at: ${ffmpegPath}`);
      const ffmpeg = spawn(ffmpegPath, [
        '-i', inputSource,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-maxrate', '3000k',
        '-bufsize', '6000k',
        '-framerate', '30',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-f', 'flv',
        rtmpUrl
      ]);
      
      // Add a timeout to check if connection was successful
      const connectionTimeout = setTimeout(() => {
        // If process is still running after 5 seconds, consider it connected
        if (ffmpegProcesses[roomId]?.[dest.platform]) {
          io.to(roomId).emit('rtmp-platform-status', {
            platform: dest.platform,
            status: 'connected'
          });
        }
      }, 5000);
      
      // Log output for debugging
      ffmpeg.stdout.on('data', (data) => {
        console.log(`FFmpeg (${dest.platform}) stdout: ${data}`);
      });
      
      ffmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        console.log(`FFmpeg (${dest.platform}) stderr: ${output}`);
        
        // Check for common error patterns
        if (output.includes('Connection refused') || 
            output.includes('Invalid argument') || 
            output.includes('Authorization failed')) {
          
          // Emit error to client
          io.to(roomId).emit('rtmp-platform-status', {
            platform: dest.platform,
            status: 'error',
            error: 'Connection failed. Please check your stream key.'
          });
          
          // Kill the process
          ffmpeg.kill('SIGTERM');
          if (ffmpegProcesses[roomId]?.[dest.platform]) {
            delete ffmpegProcesses[roomId][dest.platform];
          }
          
          clearTimeout(connectionTimeout);
        }
      });
      
      ffmpeg.on('close', (code) => {
        console.log(`FFmpeg process for ${dest.platform} exited with code ${code}`);
        if (ffmpegProcesses[roomId]?.[dest.platform]) {
          delete ffmpegProcesses[roomId][dest.platform];
        }
      });
      
      // Store process reference
      ffmpegProcesses[roomId][dest.platform] = ffmpeg;
      
      // Track active stream
      activeStreams.push({
        platform: dest.platform,
        active: true
      });
    } catch (error) {
      console.error(`Error starting ${dest.platform} stream:`, error);
      
      io.to(roomId).emit('rtmp-platform-status', {
        platform: dest.platform,
        status: 'error',
        error: error.message
      });
    }
  }
  
  return activeStreams;
}

function stopRtmpStream(roomId, platform) {
  if (!ffmpegProcesses[roomId]) {
    return { success: false, message: 'No active streams for this room' };
  }
  
  // If platform specified, stop only that stream
  if (platform && ffmpegProcesses[roomId][platform]) {
    ffmpegProcesses[roomId][platform].kill('SIGTERM');
    delete ffmpegProcesses[roomId][platform];
    return { success: true, message: `Stopped ${platform} stream` };
  } 
  // Otherwise stop all streams for this room
  else if (!platform) {
    Object.keys(ffmpegProcesses[roomId]).forEach(p => {
      ffmpegProcesses[roomId][p].kill('SIGTERM');
    });
    delete ffmpegProcesses[roomId];
    return { success: true, message: 'Stopped all streams' };
  }
  
  return { success: false, message: 'Stream not found' };
}

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