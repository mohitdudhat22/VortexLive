const logger = require('../utils/logger');
const EventEmitter = require('events');

class FfmpegEntry {
    constructor({ process, stdin, platform, roomId, metricsIntervalMs = 1000, loggerInstance = logger }) {
        this.process = process;
        this.stdin = stdin;
        this.platform = platform;
        this.roomId = roomId;
        this.logger = loggerInstance;
        this.stats = {
            chunks: 0,
            bytes: 0,
            frames: 0,
            fps: 0,
            lastFrameAt: 0,
            bitrate: null,
            backpressureEvents: 0,
            droppedChunks: 0,
            waitingForDrain: false
        };
        this.wroteHeader = false;
        this.dead = false;
        this.stdinEnded = false;
        this._metricsTimer = null;
        this._stderrBuf = '';

        // Sequential write handling - NO QUEUE
        this._currentWrite = null; // Track ongoing write
        this._isWriting = false;
        this._consecutiveBackpressure = 0;
        this._lastBackpressureLog = 0;

        this._attachHandlers();
        this._startMetrics(metricsIntervalMs);
    }

    /**
     * Write data synchronously - waits for this chunk to complete before returning
     * Returns a promise that resolves only when THIS chunk is fully written
     */
    async writeAsync(buf) {
        // Quick rejection for dead/closed streams
        if (this.dead || this.stdinEnded) {
            return false;
        }

        if (!this.stdin || this.stdin.destroyed || !this.stdin.writable) {
            this.stdinEnded = true;
            return false;
        }

        // If there's an ongoing write, wait for it to complete first
        if (this._currentWrite) {
            try {
                await this._currentWrite;
            } catch (e) {
                this.logger.error(`[ffmpeg:${this.platform}] Previous write failed: ${e.message}`);
                return false;
            }
        }

        // Now write THIS chunk synchronously
        this._currentWrite = this._doSyncWrite(buf);

        try {
            const result = await this._currentWrite;
            return result;
        } finally {
            this._currentWrite = null;
        }
    }

    /**
     * Actually write a single chunk and wait for completion
     */
    async _doSyncWrite(buf) {
        if (this.dead || this.stdinEnded) {
            return false;
        }

        const bufferSize = Buffer.isBuffer(buf) ? buf.length : Buffer.byteLength(String(buf));

        return new Promise((resolve) => {
            // Track that we're writing
            this._isWriting = true;
            this.stats.waitingForDrain = false;

            const attemptWrite = () => {
                if (this.dead || this.stdinEnded) {
                    this._isWriting = false;
                    resolve(false);
                    return;
                }

                try {
                    const canWrite = this.stdin.write(buf);

                    if (canWrite) {
                        // Success! Chunk was accepted by stdin buffer
                        this.stats.chunks++;
                        this.stats.bytes += bufferSize;
                        this._consecutiveBackpressure = 0;
                        this._isWriting = false;
                        this.stats.waitingForDrain = false;
                        resolve(true);
                    }
                } catch (e) {
                    this.logger.error(`[ffmpeg:${this.platform}] Write error: ${e.message || e}`);
                    this.stdinEnded = true;
                    this._isWriting = false;
                    this.stats.waitingForDrain = false;
                    resolve(false);
                }
            };

            attemptWrite();
        });
    }

    /**
     * Check if this entry can accept more data
     * Now this just checks if we're currently writing
     */
    canAcceptData() {
        return !this.dead &&
            !this.stdinEnded &&
            !this._isWriting;
    }

    /**
     * Wait until current write completes
     */
    async waitForSpace() {
        if (this.canAcceptData()) {
            return;
        }

        // Wait for current write to finish
        if (this._currentWrite) {
            try {
                await this._currentWrite;
            } catch (e) {
                // Ignore errors, just wait
            }
        }
    }

    /**
     * Get queue status (now just shows current write state)
     */
    getQueueStatus() {
        return {
            queueLength: this._isWriting ? 1 : 0,
            queuedBytes: 0, // No buffering
            isWriting: this._isWriting,
            waitingForDrain: this.stats.waitingForDrain,
            canAcceptData: this.canAcceptData(),
            consecutiveBackpressure: this._consecutiveBackpressure
        };
    }

    shutdown(graceMs = 2000) {
        if (this.dead) return;

        this.logger.info(`[ffmpeg:${this.platform}] Shutting down`);

        this.dead = true;
        this._isWriting = false;

        try {
            this.process.kill('SIGTERM');
        } catch (_) { }

        setTimeout(() => {
            try {
                this.process.kill('SIGKILL');
            } catch (_) { }
        }, graceMs);
    }

    _attachHandlers() {
        if (!this.process) return;

        if (this.process.stderr) {
            this.process.stderr.on('data', (d) => {
                const s = String(d);
                this._stderrBuf += s;
                if (this._stderrBuf.length > 16 * 1024) {
                    this._stderrBuf = this._stderrBuf.slice(-16 * 1024);
                }

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
            this._isWriting = false;
            if (this._metricsTimer) clearInterval(this._metricsTimer);
            this.logger.info(`[ffmpeg:${this.platform}] Process exited: code=${code}, signal=${sig}`);
        });

        this.process.on('error', (err) => {
            this.dead = true;
            this.stdinEnded = true;
            this._isWriting = false;
            if (this._metricsTimer) clearInterval(this._metricsTimer);
            this.logger.error(`[ffmpeg:${this.platform}] Process error: ${err.message}`);
        });

        if (this.stdin) {
            this.stdin.on('error', (err) => {
                this.stdinEnded = true;
                this._isWriting = false;
                this.logger.error(`[ffmpeg:${this.platform}] stdin error: ${err.message}`);
            });

            this.stdin.on('close', () => {
                this.stdinEnded = true;
                this._isWriting = false;
                this.logger.info(`[ffmpeg:${this.platform}] stdin closed`);
            });
        }
    }

    _startMetrics(intervalMs) {
        this._metricsTimer = setInterval(() => {
            if (this.dead) return clearInterval(this._metricsTimer);

            const queueStatus = this.getQueueStatus();

            // Only emit if actively writing or has backpressure
            if (this._isWriting || this.stats.backpressureEvents > 0) {
                globalThis.__RTMP_EMITTER__?.emit('metrics', {
                    roomId: this.roomId,
                    platform: this.platform,
                    pid: this.process.pid,
                    stats: { ...this.stats },
                    queue: queueStatus,
                    lastStderr: this._stderrBuf.slice(-1024)
                });
            }
        }, intervalMs);
    }
}

module.exports = FfmpegEntry;