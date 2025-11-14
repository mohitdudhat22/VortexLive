const FfmpegEntry = require('../ffmpeg/FfmpegEntry');
const runFFmpegCommand = require('../utils/ffmpegRunner');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const logger = require('../utils/logger');

class StreamPipe {
    constructor(roomId) {
        this.roomId = roomId;
        this.ffmpegEntries = [];
        this.headerChunk = null;
        this.pendingDestinations = [];
        this.stats = { 
            chunkCount: 0, 
            totalBytes: 0,
            droppedChunks: 0,
            backpressureEvents: 0
        };
        this._flushLock = false;
        
        // Keep minimal buffer (just last 10 chunks) for late joiners
        this.buffer = [];
        this._maxBufferSize = 10;
    }

    /**
     * Push chunk sequentially to all entries
     * Waits for ALL entries to finish writing before returning
     */
    async pushChunk(buf) {
        // Update buffer for late joiners (minimal)
        this.buffer.push(buf);
        if (this.buffer.length > this._maxBufferSize) {
            this.buffer.shift();
        }
        
        this.stats.chunkCount++;
        this.stats.totalBytes += buf.length;

        // If no active entries, just buffer and return immediately
        if (this.ffmpegEntries.length === 0) {
            return true;
        }

        // Write to all entries IN PARALLEL and wait for ALL to complete
        const writePromises = [];
        
        for (const entry of [...this.ffmpegEntries]) {
            // Check if entry is dead
            if (entry.dead || entry.stdinEnded) {
                this.removeEntry(entry);
                continue;
            }

            // Write header if needed
            if (!entry.wroteHeader && this.headerChunk) {
                try {
                    await entry.writeAsync(this.headerChunk);
                    entry.wroteHeader = true;
                } catch (e) {
                    logger.error(`[StreamPipe:${this.roomId}] Failed to write header to ${entry.platform}: ${e.message}`);
                    this.removeEntry(entry);
                    continue;
                }
            }

            // Add this entry's write promise to the array
            writePromises.push(
                entry.writeAsync(buf).catch(err => {
                    logger.error(`[StreamPipe:${this.roomId}] Write failed for ${entry.platform}: ${err.message}`);
                    return false;
                })
            );
        }

        // Wait for ALL entries to finish writing this chunk
        if (writePromises.length > 0) {
            const results = await Promise.all(writePromises);
            
            // Check if any write failed
            const allSucceeded = results.every(r => r === true);
            
            if (!allSucceeded) {
                this.stats.backpressureEvents++;
            }
            
            return allSucceeded;
        }

        return true;
    }

    /**
     * Check if pipe can accept more data
     * Now checks if ALL entries can accept data
     */
    canAcceptData() {
        if (this.ffmpegEntries.length === 0) {
            return true; // No entries yet, can buffer
        }

        // ALL entries must be ready (not currently writing)
        return this.ffmpegEntries.every(e => 
            !e.dead && !e.stdinEnded && e.canAcceptData()
        );
    }

    /**
     * Get overall status
     */
    getBackpressureStatus() {
        const entries = this.ffmpegEntries.map(e => ({
            platform: e.platform,
            ...e.getQueueStatus(),
            dead: e.dead,
            stdinEnded: e.stdinEnded
        }));

        const activeEntries = entries.filter(e => !e.dead && !e.stdinEnded);
        const writingEntries = activeEntries.filter(e => e.isWriting);
        
        return {
            totalEntries: this.ffmpegEntries.length,
            activeEntries: activeEntries.length,
            writingEntries: writingEntries.length,
            canAcceptData: this.canAcceptData(),
            entries,
            bufferSize: this.buffer.length,
            stats: this.stats
        };
    }

    addEntry(entry) { 
        this.ffmpegEntries.push(entry);
        logger.info(`[StreamPipe:${this.roomId}] Added entry for ${entry.platform}, total: ${this.ffmpegEntries.length}`);
    }

    removeEntry(entry) {
        const before = this.ffmpegEntries.length;
        this.ffmpegEntries = this.ffmpegEntries.filter(e => e !== entry);
        
        if (this.ffmpegEntries.length < before) {
            logger.info(
                `[StreamPipe:${this.roomId}] Removed entry for ${entry.platform}, ` +
                `remaining: ${this.ffmpegEntries.length}`
            );
        }
        
        try { 
            entry.shutdown(); 
        } catch (e) {
            logger.error(`[StreamPipe:${this.roomId}] Error shutting down entry: ${e.message}`);
        }
    }

    markHeader(buf) { 
        this.headerChunk = Buffer.from(buf);
        logger.info(`[StreamPipe:${this.roomId}] Header marked, size: ${buf.length} bytes`);
    }

    async flushPending(buildArgsFn) {
        if (this._flushLock) {
            logger.warn(`[StreamPipe:${this.roomId}] Flush already in progress`);
            return { startedPlatforms: [], failed: [] };
        }
        
        this._flushLock = true;
        const startedPlatforms = [];
        const failed = [];
        
        try {
            logger.info(`[StreamPipe:${this.roomId}] Flushing ${this.pendingDestinations.length} pending destinations`);
            
            while (this.pendingDestinations.length > 0) {
                const pd = this.pendingDestinations.shift();
                const { destination, rtmpUrl } = pd;
                const platform = destination.platform;
                
                logger.info(`[StreamPipe:${this.roomId}] Starting FFmpeg for ${platform}`);
                
                try {
                    const ffmpegArgs = buildArgsFn(rtmpUrl, destination);
                    const child = await runFFmpegCommand(ffmpegArgs, { 
                        ffmpegPath, 
                        platform,
                        spawnOptions: { stdio: ['pipe', 'pipe', 'pipe'] } 
                    });
                    
                    const entry = new FfmpegEntry({ 
                        process: child, 
                        stdin: child.stdin, 
                        platform,
                        roomId: this.roomId 
                    });
                    
                    this.addEntry(entry);
                    
                    // Write header if available
                    if (this.headerChunk && !entry.wroteHeader) { 
                        await entry.writeAsync(this.headerChunk); 
                        entry.wroteHeader = true;
                        logger.info(`[StreamPipe:${this.roomId}] Sent header to ${platform}`);
                    }
                    
                    // Write buffered chunks sequentially
                    logger.info(`[StreamPipe:${this.roomId}] Sending ${this.buffer.length} buffered chunks to ${platform}`);
                    for (const b of this.buffer) { 
                        await entry.writeAsync(b);
                    }
                    
                    startedPlatforms.push(platform);
                    logger.info(`[StreamPipe:${this.roomId}] Successfully started ${platform}`);
                    
                } catch (e) { 
                    logger.error(`[StreamPipe:${this.roomId}] Failed to start ${platform}: ${e.message}`);
                    failed.push({ platform, error: e.message });
                }
            }
            
            return { startedPlatforms, failed };
        } finally { 
            this._flushLock = false;
            logger.info(
                `[StreamPipe:${this.roomId}] Flush complete, ` +
                `started: ${startedPlatforms.length}, failed: ${failed.length}`
            );
        }
    }

    shutdownAll() { 
        logger.info(`[StreamPipe:${this.roomId}] Shutting down all entries (${this.ffmpegEntries.length})`);
        
        this.ffmpegEntries.forEach(e => {
            try {
                e.shutdown();
            } catch (err) {
                logger.error(`[StreamPipe:${this.roomId}] Error during shutdown: ${err.message}`);
            }
        });
        
        this.ffmpegEntries = [];
        this.buffer = [];
        this.headerChunk = null;
        this.pendingDestinations = [];
        
        logger.info(`[StreamPipe:${this.roomId}] Shutdown complete`);
    }
}

module.exports = StreamPipe;