const NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL
const NEXT_PUBLIC_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL
const PLATFORMS = [
    { platform: 'youtube', streamKey: '', url: 'rtmps://a.rtmp.youtube.com/live2', active: false, enabled: true },
    { platform: 'facebook', streamKey: '', url: 'rtmp://live-api-s.facebook.com:80/rtmp', active: false, enabled: false },
    { platform: 'twitch', streamKey: '', url: 'rtmp://live.twitch.tv/app', active: false, enabled: false },
    { platform: 'custom', streamKey: '', url: '', active: false, enabled: false },
  ];
const MAX_RECONNECT_ATTEMPTS = 5;
const PLATFORMS_INIT_STATS = {
          youtube: { status: 'idle', error: null },
          facebook: { status: 'idle', error: null },
          twitch: { status: 'idle', error: null },
          custom: { status: 'idle', error: null }
        }


export { NEXT_PUBLIC_API_URL, PLATFORMS, MAX_RECONNECT_ATTEMPTS, PLATFORMS_INIT_STATS, NEXT_PUBLIC_API_BASE_URL }