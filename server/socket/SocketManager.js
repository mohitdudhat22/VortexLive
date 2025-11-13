// socket/SocketManager.js
const { Server } = require('socket.io');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const Stream = require('../models/Stream');
const events = require('./events');
const { buildRtmpArgsForDestination, constructRtmpUrl, convertToBuffer, throttle } = require('../helper/index.mjs');
const runFFmpegCommand = require('../utils/ffmpegRunner');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const corsConfig = {
    cors: { origin: '*', methods: ['GET', 'POST'] }
};

class FfmpegEntry {
    constructor({ process, stdin, platform, roomId, metricsIntervalMs = 1000, loggerInstance = logger }) {
        this.process = process;
        this.stdin = stdin;
        this.platform = platform;
        this.roomId = roomId;
        this.logger = loggerInstance;
        this.stats = { chunks: 0, bytes: 0, frames: 0, fps: 0, lastFrameAt: 0, bitrate: null };
        this.wroteHeader = false;
        this.dead = false;
        this.stdinEnded = false;
        this._metricsTimer = null;
        this._stderrBuf = '';
        this._attachHandlers();
        this._startMetrics(metricsIntervalMs);
    }

    safeWrite(buf) {
        if (this.dead || this.stdinEnded) return false;
        if (!this.stdin || this.stdin.destroyed || !this.stdin.writable) {
            this.stdinEnded = true;
            return false;
        }
        try {
            const ok = this.stdin.write(buf);
            this.stats.chunks += 1;
            this.stats.bytes += Buffer.isBuffer(buf) ? buf.length : Buffer.byteLength(String(buf));
            if (!ok) {
                this.stats.backpressureEvents = (this.stats.backpressureEvents || 0) + 1;
                this.logger.warn(`[ffmpeg:${this.platform}] backpressure (#${this.stats.backpressureEvents})`);
            }
            return ok;
        } catch (e) {
            this.logger.error(`[ffmpeg:${this.platform}] safeWrite err: ${e.message || e}`);
            this.stdinEnded = true;
            return false;
        }
    }

    shutdown(graceMs = 2000) {
        if (this.dead) return;
        try { this.process.kill('SIGTERM'); } catch (_) { }
        setTimeout(() => { try { this.process.kill('SIGKILL'); } catch (_) { } }, graceMs);
    }

    _attachHandlers() {
        if (!this.process) return;
        if (this.process.stderr) {
            this.process.stderr.on('data', (d) => {
                const s = String(d);
                this._stderrBuf += s;
                if (this._stderrBuf.length > 16 * 1024) this._stderrBuf = this._stderrBuf.slice(-16 * 1024);
                const lastLine = s.trim().split(/\r?\n/).slice(-1)[0];
                if (lastLine && /frame=|fps=|bitrate=|time=|speed=/.test(lastLine)) {
                    const mFrame = lastLine.match(/frame=\s*([0-9]+)/i);
                    if (mFrame) this.stats.frames = parseInt(mFrame[1], 10);
                    const mFps = lastLine.match(/fps=\s*([\d.]+)/i);
                    if (mFps) this.stats.fps = parseFloat(mFps[1]);
                }
            });
        }

        this.process.on('exit', (code, sig) => {
            this.dead = true;
            this.stdinEnded = true;
            this.logger.info(`[ffmpeg:${this.platform}] exit code=${code} sig=${sig}`);
            if (this._metricsTimer) clearInterval(this._metricsTimer);
        });

        this.process.on('error', (err) => {
            this.dead = true;
            this.stdinEnded = true;
            this.logger.error(`[ffmpeg:${this.platform}] error: ${err && err.message}`);
            if (this._metricsTimer) clearInterval(this._metricsTimer);
        });

        if (this.stdin) {
            this.stdin.on('error', (err) => {
                this.stdinEnded = true;
                this.logger.warn(`[ffmpeg:${this.platform}] stdin error ${err && err.message}`);
            });
            this.stdin.on('close', () => { this.stdinEnded = true; });
        }
    }

    _startMetrics(intervalMs) {
        try {
            this._metricsTimer = setInterval(() => {
                if (this.dead) return clearInterval(this._metricsTimer);
                globalThis.__RTMP_EMITTER__ && globalThis.__RTMP_EMITTER__.emit('metrics', {
                    roomId: this.roomId,
                    platform: this.platform,
                    pid: this.process.pid,
                    stats: { ...this.stats },
                    lastStderr: this._stderrBuf.slice(-1024)
                });
            }, intervalMs);
        } catch (e) {
            this.logger.error('startMetrics err', { message: e.message, stack: e.stack });
        }
    }
}

class StreamPipe {
    constructor(roomId) {
        this.roomId = roomId;
        this.ffmpegEntries = [];
        this.buffer = [];
        this.headerChunk = null;
        this.pendingDestinations = [];
        this.stats = { chunkCount: 0, totalBytes: 0, lastLogAt: Date.now() };
        this._flushLock = false;
    }

    pushChunk(buf) {
        this.buffer.push(buf);
        if (this.buffer.length > 60) this.buffer.shift();
        this.stats.chunkCount += 1;
        this.stats.totalBytes += buf.length;
        // fan-out to ffmpegEntries here is optional; callers may handle fanout
        for (const e of (this.ffmpegEntries || []).slice()) {
            if (e.dead || e.stdinEnded) {
                this.removeEntry(e);
                continue;
            }
            try {
                if (!e.wroteHeader && this.headerChunk) {
                    e.safeWrite(this.headerChunk);
                    e.wroteHeader = true;
                }
                e.safeWrite(buf);
            } catch (err) {
                logger.warn(`[rtmp:${this.roomId}] write to ffmpeg ${e.platform} failed: ${err.message}`);
            }
        }
    }

    addEntry(entry) { this.ffmpegEntries.push(entry); }

    removeEntry(entry) {
        this.ffmpegEntries = this.ffmpegEntries.filter(e => e !== entry);
        try { entry.shutdown(); } catch (e) { }
    }

    markHeader(buf) { this.headerChunk = Buffer.from(buf); }

    async flushPending(buildArgsFn) {
        console.log("flush started", this.pendingDestinations.length)
        // If already flushing, return empty result so caller knows nothing was started here
        if (this._flushLock) return { startedPlatforms: [], failed: [] };
        this._flushLock = true;

        const startedPlatforms = [];
        const failed = [];

        try {
            while (this.pendingDestinations.length) {
                console.log("inside while loop")
                const pd = this.pendingDestinations.shift();
                const { destination, rtmpUrl } = pd;
                const ffmpegArgs = buildArgsFn(rtmpUrl, destination);

                try {
                    console.log("------------- line 178")
                    const child = await runFFmpegCommand(ffmpegArgs, { //TODO : have to handle the backprassure
                        ffmpegPath,
                        platform: destination.platform,
                        spawnOptions: { stdio: ['pipe', 'pipe', 'pipe'] }
                    });

                    const entry = new FfmpegEntry({
                        process: child,
                        stdin: child.stdin,
                        platform: destination.platform,
                        roomId: this.roomId
                    });

                    this.addEntry(entry);

                    // write header first if available
                    if (this.headerChunk && !entry.wroteHeader) {
                        try { entry.safeWrite(this.headerChunk); entry.wroteHeader = true; } catch (e) { /* ignore */ }
                    }

                    // replay buffered chunks
                    for (const b of this.buffer) {
                        try { entry.safeWrite(b); } catch (e) { /* ignore */ }
                    }

                    // wire lifecycle handlers so we can clean up entries on exit
                    child.on('close', (code, sig) => {
                        logger.info(`[rtmp:${this.roomId}] ffmpeg closed for ${destination.platform} code=${code} sig=${sig}`);
                        try { this.removeEntry(entry); } catch (_) { }
                    });

                    child.on('error', (err) => {
                        logger.error(`[rtmp:${this.roomId}] ffmpeg error for ${destination.platform}: ${err && err.message}`);
                        try { this.removeEntry(entry); } catch (_) { }
                    });
                    console.log("destination-------------------------", destination)
                    startedPlatforms.push(destination.platform);
                } catch (spawnErr) {
                    logger.error(`[rtmp:${this.roomId}] failed to spawn ffmpeg for ${destination.platform}: ${spawnErr && spawnErr.message}`);
                    failed.push({ platform: destination.platform, error: (spawnErr && spawnErr.message) || String(spawnErr) });
                    // continue with other pending destinations
                }
            }

            return { startedPlatforms, failed };
        } finally {
            this._flushLock = false;
        }
    }

    shutdownAll() {
        this.ffmpegEntries.forEach(e => e.shutdown(2000));
        this.ffmpegEntries = [];
        this.buffer = [];
        this.headerChunk = null;
        this.pendingDestinations = [];
    }
}

class SocketManager {
    constructor(server) {
        this.io = new Server(server, corsConfig);
        this.streamPipes = new Map();
        this.socketUsers = new Map();

        globalThis.__RTMP_EMITTER__ = new EventEmitter();
        globalThis.__RTMP_EMITTER__.on('metrics', (m) => {
            try { this.io.to(m.roomId).emit(events.TO_CLIENT.RTMP_METRICS, m); } catch (e) { }
        });

        this._attachConnection();
        this._setupShutdown();
    }

    _attachConnection() {
        this.io.on('connection', (socket) => {
            logger.info(`socket connected ${socket.id}`);
            this._attachSocketHandlers(socket);
        });
    }

    // unified ensurePipe that uses this.streamPipes
    _ensurePipe(roomId) {
        if (this.streamPipes.has(roomId)) return this.streamPipes.get(roomId);
        const pipe = new StreamPipe(roomId);
        this.streamPipes.set(roomId, pipe);
        return pipe;
    }

    _attachSocketHandlers(socket) {
        socket.on('register-user', ({ userId }) => {
            socket.userId = userId;
            this.socketUsers.set(socket.id, { userId });
            logger.info(`[register] socket=${socket.id} user=${userId}`);
        });

        socket.on('join-room', (roomId, userId) => {
            socket.join(roomId);
            logger.info(`[join] ${userId} -> ${roomId}`);
            socket.to(roomId).emit('user-connected', userId);

            socket.on('disconnect', () => {
                logger.info(`[disconnect] ${userId} (${socket.id})`);
                socket.to(roomId).emit('user-disconnected', userId);
            });
        });

        socket.on('signal', ({ userId, roomId, signal, targetUserId }) => {
            logger.info(`signal ${userId} -> ${targetUserId || 'room'} in ${roomId}`);
            if (targetUserId) {
                const clients = this.io.sockets.adapter.rooms.get(roomId) || new Set();
                for (const clientId of clients) {
                    const s = this.io.sockets.sockets.get(clientId);
                    if (s && s.userId === targetUserId) {
                        s.emit('user-signal', { userId, signal });
                        return;
                    }
                }
            }
            socket.to(roomId).emit('user-signal', { userId, signal });
        });
        
        this._throttledOnStreamData = throttle((socket, payload) => {
            return this._onStreamData(socket, payload);
        }, 20000);

        socket.on('stream-data', async (payload) => {
            try {
                this._throttledOnStreamData(socket, payload);
            } catch (e) {
                logger.error('stream-data handler error', { message: e.message, stack: e.stack });
            }
        });

        socket.on('start-rtmp-stream', async ({ roomId, userId, destinations }) => {
            try {
                await this._onStartRtmp(socket, { roomId, userId, destinations });
            } catch (e) {
                logger.error('start-rtmp-stream err', { message: e.message, stack: e.stack });
                socket.emit(events.TO_CLIENT.RTMP_ERROR, { success: false, message: e.message });
            }
        });

        socket.on('stop-rtmp-stream', ({ roomId, platform }) => {
            try { this._onStopRtmp(socket, { roomId, platform }); } catch (e) { logger.error('stop-rtmp-stream err', { message: e.message, stack: e.stack }); }
        });

        socket.on('test-rtmp-stream', (opts) => this._onTestRtmp(socket, opts));
        socket.on('send-chat-message', (m) => socket.to(m.roomId).emit('chat-message', m));
        socket.on('get-chat-history', ({ roomId }) => socket.emit('chat-history', []));
        socket.on('get-external-streaming-status', async ({ roomId }) => {
            try {
                const stream = await Stream.findOne({ roomId, active: true });
                const activePlatforms = (this.streamPipes.get(roomId)?.ffmpegEntries || []).map(e => e.platform);
                socket.emit('external-streaming-status', { active: !!stream && activePlatforms.length > 0, platforms: activePlatforms });
            } catch (e) {
                socket.emit('external-streaming-status', { active: false, platforms: [], error: e.message });
            }
        });
    }

    async _onStreamData(socket, { roomId, data, isHeader }) {
        console.log("================== inside on Stream Data");
        if (!roomId || !data) return;
        const pipe = this._ensurePipe(roomId);
        const buffer = convertToBuffer(data);
        if (!buffer) return;

        // header detection / capture
        if (isHeader || (!pipe.headerChunk && this._detectEbmlHeader(buffer))) {
            const headerStart = isHeader ? 0 : this._findEbmlPos(buffer);
            pipe.markHeader(buffer.slice(headerStart));
            logger.info(`[${roomId}] captured header (isHeader=${!!isHeader}) pendingDestinations=${pipe.pendingDestinations.length}`);

            // ONLY flush if there are pending destinations
            if (pipe.pendingDestinations.length > 0) {
                try {
                    const { startedPlatforms = [], failed = [] } = await pipe.flushPending(this._buildRtmpArgsForDestination.bind(this));
                    logger.info(`[${roomId}] flushPending result started=${JSON.stringify(startedPlatforms)} failed=${JSON.stringify(failed)}`);

                    // Emit what actually started
                    this.io.to(roomId).emit(events.TO_CLIENT.RTMP_STARTED, {
                        success: true,
                        message: 'Queued streams started',
                        destinations: startedPlatforms
                    });

                    // Optionally notify the host about any failures
                    if (failed && failed.length) {
                        socket.emit(events.TO_CLIENT.RTMP_ERROR, { success: false, message: 'Some destinations failed to start', details: failed });
                    }
                } catch (e) {
                    logger.error('flushPending error', { message: e.message, stack: e.stack });
                    this.io.to(roomId).emit(events.TO_CLIENT.RTMP_ERROR, { success: false, message: 'Failed to start queued streams' });
                }
            }
            // Don't return here - we still need to process the header chunk as data
        }

        // normal chunk (including header chunk)
        pipe.pushChunk(buffer);

        // write to active ffmpeg entries safely
        for (const entry of (pipe.ffmpegEntries || []).slice()) {
            if (entry.dead || entry.stdinEnded) {
                pipe.removeEntry(entry);
                continue;
            }
            if (!entry.wroteHeader && pipe.headerChunk) {
                entry.safeWrite(pipe.headerChunk);
                entry.wroteHeader = true;
            }
            const ok = entry.safeWrite(buffer);
            if (ok === false) {
                logger.debug(`[${entry.platform}] backpressure on pid=${entry.process.pid}`);
            }
        }

        // cleanup dead entries
        pipe.ffmpegEntries = pipe.ffmpegEntries.filter(e => !e.dead && !e._exited);
    }

    async _onStartRtmp(socket, { roomId, userId, destinations }) {
        console.log("=== START RTMP ===");
        console.log("roomId:", roomId);
        console.log("destinations:", destinations.map(d => d.platform));

        if (!Array.isArray(destinations) || destinations.length === 0) {
            socket.emit(events.TO_CLIENT.RTMP_ERROR, { success: false, message: 'No streaming destinations provided' });
            return;
        }

        const pipe = this._ensurePipe(roomId);
        console.log("=== PIPE STATE ===");
        console.log("headerChunk exists:", !!pipe.headerChunk);
        console.log("buffer length:", pipe.buffer.length);
        console.log("pendingDestinations before:", pipe.pendingDestinations.length);
        console.log("active ffmpeg entries:", pipe.ffmpegEntries.length);

        // ALWAYS queue destinations first
        let queued = 0;

        for (const destination of destinations) {
            if (!destination.streamKey || !destination.streamKey.trim()) {
                socket.emit(events.TO_CLIENT.RTMP_ERROR, { success: false, message: `Missing stream key for ${destination.platform}` });
                continue;
            }

            const rtmpUrl = constructRtmpUrl(destination.platform.toLowerCase(), destination.streamKey, destination.url);
            console.log(`Queueing ${destination.platform} with URL:`, rtmpUrl);

            // Queue the destination
            pipe.pendingDestinations.push({ destination, rtmpUrl });
            queued++;
            console.log(`Queued ${destination.platform}, total pending: ${pipe.pendingDestinations.length}`);
            this.io.to(roomId).emit(events.TO_CLIENT.RTMP_STATUS, { platform: destination.platform, status: 'connecting' });
        }

        console.log("Total queued:", queued);
        console.log("pendingDestinations after queueing:", pipe.pendingDestinations.length);

        // If header already exists, flush immediately
        if (pipe.headerChunk) {
            console.log("=== HEADER EXISTS - FLUSHING IMMEDIATELY ===");
            try {
                const { startedPlatforms = [], failed = [] } = await pipe.flushPending(this._buildRtmpArgsForDestination.bind(this));
                console.log("=== FLUSH RESULT ===");
                console.log("startedPlatforms:", startedPlatforms);
                console.log("failed:", failed);
                console.log("Active ffmpeg entries after flush:", pipe.ffmpegEntries.length);

                // Log details of each entry
                pipe.ffmpegEntries.forEach((entry, idx) => {
                    console.log(`Entry ${idx}:`, {
                        platform: entry.platform,
                        pid: entry.process?.pid,
                        dead: entry.dead,
                        stdinEnded: entry.stdinEnded,
                        wroteHeader: entry.wroteHeader
                    });
                });

                if (startedPlatforms.length > 0) {
                    socket.emit(events.TO_CLIENT.RTMP_STARTED, {
                        success: true,
                        message: `Started ${startedPlatforms.length} stream(s)`,
                        destinations: startedPlatforms
                    });
                }

                if (failed.length > 0) {
                    socket.emit(events.TO_CLIENT.RTMP_ERROR, {
                        success: false,
                        message: 'Some destinations failed to start',
                        details: failed
                    });
                }
            } catch (e) {
                logger.error('Immediate flush error', { message: e.message, stack: e.stack });
                socket.emit(events.TO_CLIENT.RTMP_ERROR, { success: false, message: 'Failed to start streams: ' + e.message });
            }
        } else {
            // No header yet, wait for it
            console.log("=== NO HEADER - WAITING ===");
            socket.emit(events.TO_CLIENT.RTMP_STARTED, {
                success: true,
                message: 'Streams queued. Waiting for video header...',
                destinations: destinations.map(d => d.platform)
            });
            this.io.to(roomId).emit(events.TO_CLIENT.REQUEST_HEADER, { roomId });
        }

        console.log("=== END START RTMP ===");
    }

    _onStopRtmp(socket, { roomId, platform }) {
        const pipe = this.streamPipes.get(roomId);
        if (!pipe) {
            socket.emit(events.TO_CLIENT.RTMP_ERROR, { success: false, message: 'No active streams for this room' });
            return;
        }

        if (platform) {
            const entry = pipe.ffmpegEntries.find(e => e.platform === platform);
            if (entry) {
                entry.shutdown();
                pipe.removeEntry(entry);
                socket.emit(events.TO_CLIENT.RTMP_STOPPED, { success: true, platform });
                return;
            }
            socket.emit(events.TO_CLIENT.RTMP_ERROR, { success: false, message: `Platform ${platform} not found` });
            return;
        }

        pipe.shutdownAll();
        this.streamPipes.delete(roomId);
        socket.emit(events.TO_CLIENT.RTMP_STOPPED, { success: true, message: 'All streams stopped' });
    }

    async _onTestRtmp(socket, { roomId, platform, url, streamKey, duration }) {
        try {
            const testDuration = Math.max(3, Math.min(Number(duration) || 10, 120));
            const rtmpUrl = constructRtmpUrl((platform || '').toLowerCase(), streamKey, url);
            this.io.to(roomId).emit(events.TO_CLIENT.RTMP_STATUS, { platform, status: 'connecting' });
            const args = [
                '-re',
                '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=30:duration=${testDuration}`,
                '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=44100:duration=${testDuration}`,
                '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level', '3.1', '-g', '60', '-r', '30',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-f', 'flv', rtmpUrl
            ];

            const ff = await runFFmpegCommand(args, { ffmpegPath, platform, spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] } });
            let started = false;
            let stderr = '';
            if (ff.stderr) {
                ff.stderr.on('data', d => {
                    const s = String(d);
                    stderr += s;
                    if (!started && (/frame=|Stream mapping:/).test(s)) {
                        started = true;
                        this.io.to(roomId).emit(events.TO_CLIENT.RTMP_STATUS, { platform, status: 'streaming' });
                    }
                    if (/Connection refused|403 Forbidden|401 Unauthorized|timed out|Failed to open|Could not write header/i.test(s)) {
                        this.io.to(roomId).emit(events.TO_CLIENT.RTMP_STATUS, { platform, status: 'error', error: 'RTMP connection failed' });
                        try { ff.process.kill('SIGTERM'); } catch (_) { }
                    }
                });
            }

            ff.process.on('close', (code) => {
                if (code === 0 || started) this.io.to(roomId).emit(events.TO_CLIENT.RTMP_STATUS, { platform, status: 'idle' });
                else this.io.to(roomId).emit(events.TO_CLIENT.RTMP_STATUS, { platform, status: 'error', error: stderr.slice(-400) || 'FFmpeg failed' });
            });
        } catch (e) {
            socket.emit(events.TO_CLIENT.RTMP_ERROR, { success: false, message: e.message });
        }
    }

    _detectEbmlHeader(buf) {
        return this._findEbmlPos(buf) >= 0;
    }

    _findEbmlPos(buf) {
        const MAGIC = [0x1A, 0x45, 0xDF, 0xA3];
        const limit = Math.min(buf.length - 4, 8192);
        for (let i = 0; i <= limit; i++) {
            if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) return i;
        }
        return -1;
    }

    _buildRtmpArgsForDestination(rtmpUrl, destination = {}) {
        return buildRtmpArgsForDestination(rtmpUrl);
    }

    _setupShutdown() {
        const cleanup = () => {
            logger.info('Shutdown: cleaning up ffmpeg procs');
            for (const [roomId, pipe] of this.streamPipes.entries()) {
                pipe.shutdownAll();
            }
            try { this.io.close(); } catch (e) { }
            process.exit(0);
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
    }
}

module.exports = SocketManager;
