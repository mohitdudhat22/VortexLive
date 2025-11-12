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
    '-thread_queue_size', '1024',
    '-probesize', '5M',
    '-analyzeduration', '5M',
    '-f', 'webm',
    '-i', 'pipe:0',

    // Let ffmpeg auto-map (safer if audio sometimes missing)
    // '-map', '0', // explicit map could be used if you prefer

    // Video encoding
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

    // Audio encoding
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',

    // Streaming
    '-flush_packets', '1',
    '-f', 'flv',
    rtmpUrl
  ];
}
