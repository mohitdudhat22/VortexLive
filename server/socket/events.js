// events.js
module.exports = {
  TO_CLIENT: {
    RTMP_STATUS: 'rtmp-platform-status',
    RTMP_METRICS: 'rtmp-platform-metrics',
    RTMP_ERROR: 'rtmp-stream-error',
    RTMP_STARTED: 'rtmp-stream-started',
    RTMP_STOPPED: 'rtmp-stream-stopped',
    REQUEST_HEADER: 'request-media-header',
    USER_SIGNAL: 'user-signal',
    CHAT_MESSAGE: 'chat-message',
    CHAT_HISTORY: 'chat-history',
  },
  FROM_CLIENT: {
    START_RTMP: 'start-rtmp-stream',
    STOP_RTMP: 'stop-rtmp-stream',
    STREAM_DATA: 'stream-data',
    REGISTER_USER: 'register-user',
    SIGNAL: 'signal',
    GET_STATUS: 'get-external-streaming-status',
    TEST_RTMP: 'test-rtmp-stream',
  }
};
