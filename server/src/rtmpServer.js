const NodeMediaServer = require('node-media-server');
const winston = require('winston'); // Optional but recommended for structured logging
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { spawn } = require('child_process');

// Create a logger
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'rtmp-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'rtmp-combined.log' })
  ]
});

// Configure the RTMP server with detailed logging
const config = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: 8000,
    allow_origin: '*'
  },
  logType: 3, // Log everything: 0=NONE, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG
};

const nms = new NodeMediaServer(config);

// Record active stream processes to manage them
const activeStreams = new Map();

// Add custom event handlers with detailed logging
nms.on('preConnect', (id, args) => {
  logger.info('RTMP Connection attempt', { 
    id, 
    ip: args.ip,
    timestamp: new Date().toISOString()
  });
});

nms.on('postConnect', (id, args) => {
  logger.info('RTMP Connection established', { 
    id, 
    ip: args.ip,
    timestamp: new Date().toISOString() 
  });
});

nms.on('doneConnect', (id, args) => {
  logger.info('RTMP Connection ended', { 
    id, 
    ip: args.ip,
    timestamp: new Date().toISOString() 
  });
});

nms.on('prePublish', (id, StreamPath, args) => {
  logger.info('RTMP Stream publish attempt', { 
    id, 
    streamPath: StreamPath,
    publishArgs: JSON.stringify(args),
    timestamp: new Date().toISOString()
  });
});

nms.on('postPublish', (id, StreamPath, args) => {
  logger.info('RTMP Stream published successfully', { 
    id, 
    streamPath: StreamPath, 
    publishArgs: args,
    timestamp: new Date().toISOString()
  });
  
  // Check if this stream should be republished (typically set from socket.io)
  const streamData = args.streamData || {};
  
  if (streamData.destinations && streamData.destinations.length > 0) {
    streamData.destinations.forEach(destination => {
      if (!destination.streamKey || !destination.url) {
        logger.warn('Missing streamKey or URL for destination', { platform: destination.platform });
        return;
      }
      
      logger.info(`Republishing stream to ${destination.platform}`, {
        fromPath: StreamPath,
        toUrl: `${destination.url}/[STREAM_KEY_HIDDEN]`
      });
      
      // Use @ffmpeg-installer/ffmpeg path
      const ffmpeg = spawn(ffmpegPath, [
        '-i', `rtmp://localhost:1935${StreamPath}`,
        '-c:v', 'copy',  // Copy video codec without re-encoding
        '-c:a', 'copy',  // Copy audio codec without re-encoding
        '-f', 'flv',
        `${destination.url}/${destination.streamKey}`
      ]);
      
      // Add detailed logging for the ffmpeg process
      ffmpeg.stdout.on('data', (data) => {
        logger.debug(`FFMPEG stdout (${destination.platform}): ${data.toString().trim()}`);
      });
      
      ffmpeg.stderr.on('data', (data) => {
        // FFMPEG typically logs to stderr even for non-errors
        const message = data.toString().trim();
        if (message.includes('Error') || message.includes('error')) {
          logger.error(`FFMPEG error (${destination.platform}): ${message}`);
        } else {
          logger.debug(`FFMPEG info (${destination.platform}): ${message}`);
        }
      });
      
      ffmpeg.on('error', (error) => {
        logger.error(`FFMPEG process error (${destination.platform}):`, error);
      });
      
      ffmpeg.on('close', (code) => {
        logger.info(`FFMPEG process for ${destination.platform} exited with code ${code}`);
        // Remove from active streams
        activeStreams.delete(`${id}-${destination.platform}`);
      });
      
      // Store the ffmpeg process reference for potential termination later
      activeStreams.set(`${id}-${destination.platform}`, {
        process: ffmpeg,
        platform: destination.platform,
        startTime: new Date().toISOString()
      });
    });
  }
});

nms.on('donePublish', (id, StreamPath, args) => {
  logger.info('RTMP Stream publishing ended', { 
    id, 
    streamPath: StreamPath,
    timestamp: new Date().toISOString()
  });
  
  // Terminate any ffmpeg processes for this stream
  for (const [streamId, streamData] of activeStreams.entries()) {
    if (streamId.startsWith(id)) {
      logger.info(`Terminating ffmpeg process for ${streamData.platform}`);
      try {
        streamData.process.kill('SIGTERM');
        activeStreams.delete(streamId);
      } catch (error) {
        logger.error(`Error terminating ffmpeg process for ${streamData.platform}:`, error);
      }
    }
  }
});

nms.run();

// Function to be used with socket.io to start streaming
const startStreaming = (roomId, userId, destinations) => {
  logger.info('Received streaming request', { roomId, userId, destinations: destinations.map(d => d.platform) });
  
  // Create a stream key for the local RTMP server
  const localStreamKey = `${roomId}/${userId}`;
  
  // Store the destination information to be used in postPublish
  nms.streamData = nms.streamData || {};
  nms.streamData[`/${localStreamKey}`] = {
    roomId,
    userId,
    destinations,
    startTime: new Date().toISOString()
  };
  
  return {
    success: true,
    rtmpUrl: `rtmp://localhost:1935/${localStreamKey}`,
    streamKey: localStreamKey
  };
};

module.exports = {
  nms,
  startStreaming,
  activeStreams
}; 