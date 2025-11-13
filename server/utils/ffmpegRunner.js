// utils/ffmpegRunner.js
const { spawn } = require('child_process');
const logger = require('./logger');

/**
 * Spawn ffmpeg and wire logging/events.
 *
 * @param {string[]} args - ffmpeg CLI args (not including ffmpeg binary)
 * @param {object} [opts]
 * @param {string} [opts.ffmpegPath='ffmpeg'] - path to ffmpeg binary
 * @param {string} [opts.platform] - label used for logging
 * @param {object} [opts.spawnOptions] - options forwarded to child_process.spawn
 * @returns {Promise<ChildProcess>} resolves to the spawned child process
 */
function runFFmpegCommand(args, opts = {}) {
  const {
    ffmpegPath = 'ffmpeg',
    platform = 'unknown',
    spawnOptions = { stdio: ['pipe', 'pipe', 'pipe'] },
  } = opts;
  console.log("ffmpeg running......")

  return new Promise((resolve, reject) => {
    try {
      const child = spawn(ffmpegPath, args, spawnOptions);

      // Small guard: if spawn returned null-ish, reject
      if (!child || !child.pid) {
        const err = new Error('Failed to spawn ffmpeg process');
        (logger && logger.error) ? logger.error(`[FFmpeg ${platform}] spawn failed`) : console.error(`[FFmpeg ${platform}] spawn failed`);
        return reject(err);
      }

      // stdout - informational
      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          const msg = chunk.toString().trim();
          if (msg) {
            (logger && logger.info) ? logger.info(`[FFmpeg ${platform} STDOUT] ${msg}`) : console.log(`[FFmpeg ${platform} STDOUT] ${msg}`);
          }
        });
      }

      // stderr - ffmpeg progress and warnings
      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          const msg = chunk.toString().trim();
          if (msg) {
            (logger && logger.warn) ? logger.warn(`[FFmpeg ${platform} STDERR] ${msg}`) : console.warn(`[FFmpeg ${platform} STDERR] ${msg}`);
          }
        });
      }

      // exit/close handlers
      child.on('close', (code, signal) => {
        const message = `[FFmpeg ${platform}] closed (code=${code} signal=${signal})`;
        (logger && logger.info) ? logger.info(message) : console.log(message);
      });

      child.on('exit', (code, signal) => {
        const message = `[FFmpeg ${platform}] exit (code=${code} signal=${signal})`;
        (logger && logger.info) ? logger.info(message) : console.log(message);
      });

      child.on('error', (err) => {
        const message = `[FFmpeg ${platform}] process error: ${err.message}`;
        (logger && logger.error) ? logger.error(message) : console.error(message);
        // reject only on spawn-level error (child 'error' often means spawn failed)
        reject(err);
      });

      // Provide a safe write wrapper to handle EPIPE or other write errors
      // Consumers can still use child.stdin directly, but this helper is convenient.
      child.safeWrite = function safeWrite(chunk) {
        try {
          if (!child.stdin || child.stdin.destroyed) {
            const m = `[FFmpeg ${platform}] stdin not writable - discarding chunk`;
            (logger && logger.warn) ? logger.warn(m) : console.warn(m);
            return false;
          }
          // chunk is Buffer or Uint8Array
          return child.stdin.write(chunk);
        } catch (err) {
          const msg = `[FFmpeg ${platform}] safeWrite error: ${err.message}`;
          (logger && logger.warn) ? logger.warn(msg) : console.warn(msg);
          return false;
        }
      };

      // Expose helpful metadata for upstream
      child.meta = { platform, args, ffmpegPath };

      // resolve with the child
      resolve(child);
    } catch (err) {
      (logger && logger.error) ? logger.error(`[FFmpeg ${opts.platform || 'unknown'}] spawn exception: ${err.message}`) : console.error(err);
      reject(err);
    }
  });
}

module.exports = runFFmpegCommand;
