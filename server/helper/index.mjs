// utils/convertToBuffer.js

/**
 * Safely converts incoming stream data (from client socket events)
 * into a Node.js Buffer, handling all possible formats.
 *
 * @param {any} data - The raw stream data (Buffer, ArrayBuffer, Uint8Array, base64 string, etc.)
 * @returns {Buffer} - Node.js Buffer
 */
export function convertToBuffer(data) {
  if (!data) {
    throw new Error('convertToBuffer: data is null or undefined');
  }

  // Case 1: already a Buffer
  if (Buffer.isBuffer(data)) return data;

  // Case 2: ArrayBuffer (browser binary)
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));

  // Case 3: Uint8Array or similar typed array
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);

  // Case 4: Base64 string (common if you use .toString('base64') or DataURLs)
  if (typeof data === 'string') {
    // Try to detect base64 vs normal text
    const isBase64 = /^[A-Za-z0-9+/=]+$/.test(data.replace(/\s/g, ''));
    return isBase64 ? Buffer.from(data, 'base64') : Buffer.from(data);
  }

  // Fallback
  throw new TypeError(`convertToBuffer: Unsupported data type ${typeof data}`);
}

export const constructRtmpUrl = (platform, streamKey, customUrl = '') => {
  if (!platform || !streamKey) {
    console.error('Missing platform or stream key');
    return null;
  }

  const urls = {
    youtube: `rtmps://a.rtmp.youtube.com:443/live2/${streamKey}`,
    twitch: `rtmp://live.twitch.tv/app/${streamKey}`,
    facebook: `rtmps://live-api-s.facebook.com:443/rtmp/${streamKey}`,
    kick: `rtmp://fa.kick.com/live/${streamKey}`,
    custom: `${customUrl.endsWith('/') ? customUrl : customUrl + '/'}${streamKey}`,
  };

  const url = urls[platform.toLowerCase()];
  if (!url) {
    console.error(`Unknown platform: ${platform}`);
    return null;
  }

  console.log(`🔗 RTMP URL for ${platform}:`, url.replace(streamKey, '****'));
  return url;
};

export function buildRtmpArgsForDestination(rtmpUrl) {
  return [
    // Input (chunked WebM from MediaRecorder over stdin)
    '-fflags', '+genpts+discardcorrupt',
    '-use_wallclock_as_timestamps', '1',

    // small-ish queue for bursts (increase if you have short bursts)
    '-thread_queue_size', '2048',

    // minimize probing/analysis for low latency (was 5M which causes big buffering)
    '-probesize', '32k',
    '-analyzeduration', '0',

    '-f', 'webm',
    '-i', 'pipe:0',

    // video encoding
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-x264-params', 'no-scenecut',
    '-maxrate', '3000k',
    '-bufsize', '6000k',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-keyint_min', '60',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-r', '30',

    // audio encoding
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',

    // flush packets ASAP and output to FLV for RTMP
    '-flush_packets', '1',
    '-f', 'flv',
    rtmpUrl
  ];
}

export function throttle(fn, delay) {
  let lastCall = 0;
  let timeoutId = null;
  let lastArgs;
  let lastThis;

  return function (...args) {
    const now = Date.now();
    const remaining = delay - (now - lastCall);
    lastArgs = args;
    lastThis = this;

    if (remaining <= 0) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      lastCall = now;
      fn.apply(lastThis, lastArgs);
    } else if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        timeoutId = null;
        fn.apply(lastThis, lastArgs);
      }, remaining);
    }
  };
}
// helper/index.mjs
export function throttleAsync(fn, intervalMs = 30) {
  let last = 0;
  return async function (...args) {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    await fn(...args);
  };
}


