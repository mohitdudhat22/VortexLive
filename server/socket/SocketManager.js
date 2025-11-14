const { Server } = require('socket.io');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const StreamPipe = require('../stream/StreamPipe');
const { buildRtmpArgsForDestination, constructRtmpUrl } = require('../helper/index.mjs');
const events = require('./events');

const corsConfig = {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    maxHttpBufferSize: 1e7, // 10MB
    pingTimeout: 60000,
    pingInterval: 25000
};

class SocketManager {
    constructor(server) {
        this.io = new Server(server, corsConfig);
        this.streamPipes = new Map();
        this.socketUsers = new Map();
        this.processingChunks = new Map(); // Track per-room processing state

        globalThis.__RTMP_EMITTER__ = new EventEmitter();
        globalThis.__RTMP_EMITTER__.on('metrics', m => {
            try {
                this.io.to(m.roomId).emit(events.TO_CLIENT.RTMP_METRICS, m);
            } catch (e) {
                logger.error('Error emitting metrics:', e);
            }
        });

        this._attachConnection();
        this._setupShutdown();
    }

    _attachConnection() {
        this.io.on('connection', socket => {
            logger.info(`Socket connected: ${socket.id}`);
            this._attachSocketHandlers(socket);
        });
    }

    _ensurePipe(roomId) {
        if (this.streamPipes.has(roomId)) {
            return this.streamPipes.get(roomId);
        }
        const pipe = new StreamPipe(roomId);
        this.streamPipes.set(roomId, pipe);
        logger.info(`Created new StreamPipe for room: ${roomId}`);
        return pipe;
    }

    _attachSocketHandlers(socket) {
        // Register user
        socket.on('register-user', ({ userId }) => {
            socket.userId = userId;
            this.socketUsers.set(socket.id, { userId });
            logger.info(`User registered: ${userId} (socket: ${socket.id})`);
        });

        // Join room
        socket.on('join-room', (roomId, userId) => {
            socket.join(roomId);
            socket.to(roomId).emit('user-connected', userId);
            logger.info(`User ${userId} joined room ${roomId}`);

            socket.on('disconnect', () => {
                socket.to(roomId).emit('user-disconnected', userId);
                this.processingChunks.delete(roomId);
                logger.info(`User ${userId} disconnected from room ${roomId}`);
            });
        });

        // Handle stream data with STRICT sequential processing
        socket.on('stream-data', async (payload, ackCallback) => {
            const startTime = Date.now();

            try {
                const shouldContinue = await this._onStreamData(socket, payload);
                const duration = Date.now() - startTime;

                // Send acknowledgment with backpressure status
                if (typeof ackCallback === 'function') {
                    ackCallback({
                        shouldContinue,
                        processingTime: duration,
                        timestamp: Date.now()
                    });
                }
            } catch (e) {
                logger.error(`Error handling stream-data: ${e.message}`, e);
                if (typeof ackCallback === 'function') {
                    ackCallback({
                        shouldContinue: false,
                        error: e.message
                    });
                }
            }
        });

        // Client asking if it can resume sending
        socket.on('can-resume', ({ roomId }, callback) => {
            const pipe = this.streamPipes.get(roomId);
            const isProcessing = this.processingChunks.get(roomId);
            const canResume = pipe && !isProcessing && pipe.canAcceptData();

            logger.info(`Client ${socket.id} asking to resume for room ${roomId}: ${canResume}`);

            if (typeof callback === 'function') {
                callback({
                    shouldResume: canResume,
                    status: pipe ? pipe.getBackpressureStatus() : null
                });
            }
        });

        // Start RTMP streaming
        socket.on('start-rtmp-stream', async (opts) => {
            await this._onStartRtmp(socket, opts);
        });

        // Stop RTMP streaming
        socket.on('stop-rtmp-stream', (opts) => {
            this._onStopRtmp(socket, opts);
        });

        // Test RTMP destination
        socket.on('test-rtmp-stream', (opts) => {
            this._onTestRtmp(socket, opts);
        });

        // Cleanup on disconnect
        socket.on('disconnect', () => {
            this.socketUsers.delete(socket.id);
            logger.info(`Socket disconnected: ${socket.id}`);
        });
    }

    /**
     * Handle incoming stream data with SEQUENTIAL processing
     * Only one chunk is processed at a time per room
     * Returns true if client should continue, false if should pause
     */
    async _onStreamData(socket, { roomId, data, isHeader }) {
        if (!roomId || !data) {
            logger.warn('Missing roomId or data in stream-data event');
            return true;
        }

        // Check if we're already processing a chunk for this room
        if (this.processingChunks.get(roomId)) {
            logger.warn(`[SocketManager] Room ${roomId} is already processing a chunk, asking client to pause`);
            return false; // Tell client to pause
        }

        // Mark this room as processing
        this.processingChunks.set(roomId, true);

        try {
            const pipe = this._ensurePipe(roomId);

            // Convert base64 to Buffer (backward compatibility)
            let buffer;
            if (typeof data === 'string') {
                buffer = Buffer.from(data, 'base64');
            } else if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
                buffer = Buffer.from(data);
            } else {
                logger.error('Invalid data type received:', typeof data);
                return false;
            }

            // Mark header if this is the first chunk
            if (isHeader && !pipe.headerChunk) {
                pipe.markHeader(buffer);

                // Try to flush pending destinations
                if (pipe.pendingDestinations.length > 0) {
                    const result = await pipe.flushPending(this._buildRtmpArgsForDestination.bind(this));

                    // Notify client
                    socket.emit(events.TO_CLIENT.RTMP_STARTED, {
                        success: result.startedPlatforms.length > 0,
                        message: `Started ${result.startedPlatforms.length} stream(s)`,
                        destinations: result.startedPlatforms,
                        failed: result.failed
                    });

                    // Emit individual platform statuses
                    result.startedPlatforms.forEach(platform => {
                        socket.emit(events.TO_CLIENT.RTMP_PLATFORM_STATUS, {
                            platform,
                            status: 'streaming',
                            error: null
                        });
                    });

                    result.failed.forEach(({ platform, error }) => {
                        socket.emit(events.TO_CLIENT.RTMP_PLATFORM_STATUS, {
                            platform,
                            status: 'error',
                            error
                        });
                    });
                }
            }

            // Push chunk and WAIT for ALL entries to finish writing
            const success = await pipe.pushChunk(buffer);

            // Return whether client can continue
            // Only continue if write succeeded AND pipe can accept more data
            return success && pipe.canAcceptData();

        } finally {
            // Mark processing complete for this room
            this.processingChunks.delete(roomId);
        }
    }

    async _onStartRtmp(socket, { roomId, destinations }) {
        logger.info(
            `Starting RTMP for room ${roomId}, ` +
            `destinations: ${destinations.map(d => d.platform).join(', ')}`
        );

        const pipe = this._ensurePipe(roomId);

        // Queue destinations
        destinations.forEach(d => {
            const rtmpUrl = constructRtmpUrl(d.platform, d.streamKey, d.url);
            if (pipe.pendingDestinations.length == 0) {
                pipe.pendingDestinations.push({
                    destination: d,
                    rtmpUrl
                });
                logger.info(`Queued ${d.platform}: ${rtmpUrl.substring(0, 50)}...`);
            }
        });

        // If we have a header, flush immediately
        if (pipe.headerChunk) {
            const result = await pipe.flushPending(this._buildRtmpArgsForDestination.bind(this));

            socket.emit(events.TO_CLIENT.RTMP_STARTED, {
                success: result.startedPlatforms.length > 0,
                message: result.startedPlatforms.length > 0
                    ? `Started streaming to ${result.startedPlatforms.length} platform(s)`
                    : 'Failed to start any streams',
                destinations: result.startedPlatforms,
                failed: result.failed
            });

            // Emit individual platform statuses
            result.startedPlatforms.forEach(platform => {
                socket.emit(events.TO_CLIENT.RTMP_PLATFORM_STATUS, {
                    platform,
                    status: 'streaming',
                    error: null
                });
            });

            result.failed.forEach(({ platform, error }) => {
                socket.emit(events.TO_CLIENT.RTMP_PLATFORM_STATUS, {
                    platform,
                    status: 'error',
                    error
                });
            });
        } else {
            socket.emit(events.TO_CLIENT.RTMP_STARTED, {
                success: true,
                message: 'Streams queued. Waiting for media header.',
                destinations: destinations.map(d => d.platform)
            });
        }
    }

    _onStopRtmp(socket, { roomId, platform }) {
        logger.info(`Stopping RTMP for room ${roomId}${platform ? `, platform: ${platform}` : ''}`);

        const pipe = this.streamPipes.get(roomId);
        if (!pipe) {
            logger.warn(`No pipe found for room ${roomId}`);
            return;
        }

        if (platform) {
            // Stop specific platform
            const entry = pipe.ffmpegEntries.find(e => e.platform === platform);
            if (entry) {
                logger.info(`Stopping ${platform} for room ${roomId}`);
                entry.shutdown();
                pipe.removeEntry(entry);

                socket.emit(events.TO_CLIENT.RTMP_PLATFORM_STATUS, {
                    platform,
                    status: 'idle',
                    error: null
                });
            }
        } else {
            // Stop all platforms
            logger.info(`Stopping all platforms for room ${roomId}`);
            pipe.shutdownAll();
            this.streamPipes.delete(roomId);
            this.processingChunks.delete(roomId);

            socket.emit(events.TO_CLIENT.RTMP_STOPPED, {
                success: true,
                message: 'All streams stopped'
            });
        }
    }

    _onTestRtmp(socket, opts) {
        logger.info(`Test RTMP requested for platform: ${opts.platform}`);
        socket.emit(events.TO_CLIENT.RTMP_PLATFORM_STATUS, {
            platform: opts.platform,
            status: 'testing',
            error: null
        });
    }

    _buildRtmpArgsForDestination(rtmpUrl, destination = {}) {
        return buildRtmpArgsForDestination(rtmpUrl);
    }

    _setupShutdown() {
        const cleanup = () => {
            logger.info('Shutting down SocketManager...');

            for (const pipe of this.streamPipes.values()) {
                pipe.shutdownAll();
            }

            this.processingChunks.clear();

            try {
                this.io.close();
            } catch (e) {
                logger.error('Error closing socket.io:', e);
            }

            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
    }
}

module.exports = SocketManager;