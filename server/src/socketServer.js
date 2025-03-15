const socketIo = require('socket.io');
const { nms, startStreaming, activeStreams } = require('./rtmpServer');
const winston = require('winston');

// Create or reuse logger
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'socket-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'socket-combined.log' })
  ]
});

function setupSocketServer(server) {
  const io = socketIo(server, {
    cors: {
      origin: process.env.FRONTEND_URL || "https://ms307k82-3000.inc1.devtunnels.ms",
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: false
    },
    transports: ['websocket', 'polling']
  });

  io.on('connection', (socket) => {
    logger.info('Socket connected', { socketId: socket.id });
    
    socket.on('join-room', (roomId, userId) => {
      logger.info('User joined room', { socketId: socket.id, roomId, userId });
      socket.join(roomId);
      socket.userId = userId;
      socket.roomId = roomId;
      socket.to(roomId).emit('user-connected', userId);
    });
    
    socket.on('start-rtmp-stream', async ({ roomId, userId, destinations }) => {
      try {
        logger.info('Stream start requested', { 
          socketId: socket.id,
          roomId,
          userId,
          destinations: destinations.map(d => ({ 
            platform: d.platform,
            url: d.url
          }))
        });
        
        // Start the streaming process
        const result = startStreaming(roomId, userId, destinations);
        
        // Send the result back to the client
        socket.emit('rtmp-stream-started', { 
          success: true,
          message: 'Stream started successfully',
          destinations: destinations.map(d => d.platform)
        });
        
        // Notify the room that streaming has started
        io.to(roomId).emit('stream-started', { userId, platforms: destinations.map(d => d.platform) });
        
        // Set up periodic status updates for this stream
        const statusInterval = setInterval(() => {
          const activeStreamIds = Array.from(activeStreams.keys())
            .filter(id => id.includes(userId));
          
          if (activeStreamIds.length > 0) {
            // Stream is still active
            const platformStatus = {};
            activeStreamIds.forEach(id => {
              const stream = activeStreams.get(id);
              platformStatus[stream.platform] = {
                status: 'active',
                uptime: (new Date() - new Date(stream.startTime)) / 1000,
                platform: stream.platform
              };
            });
            
            socket.emit('rtmp-status', platformStatus);
          } else {
            // No active streams found for this user
            clearInterval(statusInterval);
            logger.info('No active streams found for user, stopping status updates', { userId });
          }
        }, 5000);
        
        // Store the interval for cleanup
        socket.statusInterval = statusInterval;
        
      } catch (error) {
        logger.error('Error starting RTMP stream', { error: error.message, stack: error.stack });
        socket.emit('rtmp-stream-error', { 
          success: false, 
          message: 'Failed to start streaming', 
          error: error.message 
        });
      }
    });
    
    socket.on('stop-rtmp-stream', () => {
      const { roomId, userId } = socket;
      if (!roomId || !userId) {
        logger.warn('Stop stream requested but missing roomId or userId', { socketId: socket.id });
        return;
      }
      
      logger.info('Stop stream requested', { socketId: socket.id, roomId, userId });
      
      // Find and terminate all ffmpeg processes for this user
      const userStreams = Array.from(activeStreams.keys())
        .filter(id => id.includes(userId));
      
      userStreams.forEach(streamId => {
        const stream = activeStreams.get(streamId);
        logger.info(`Stopping stream to ${stream.platform}`, { userId });
        try {
          stream.process.kill('SIGTERM');
          activeStreams.delete(streamId);
        } catch (error) {
          logger.error(`Error stopping stream to ${stream.platform}:`, error);
        }
      });
      
      // Notify the client and room
      socket.emit('rtmp-stream-stopped', { success: true, message: 'Stream stopped' });
      io.to(roomId).emit('stream-ended', { userId });
      
      // Clear the status interval
      if (socket.statusInterval) {
        clearInterval(socket.statusInterval);
        socket.statusInterval = null;
      }
    });
    
    socket.on('disconnect', () => {
      logger.info('Socket disconnected', { socketId: socket.id });
      
      // Clean up any status intervals
      if (socket.statusInterval) {
        clearInterval(socket.statusInterval);
      }
      
      // Optionally stop any active streams for this user
      if (socket.userId) {
        const userStreams = Array.from(activeStreams.keys())
          .filter(id => id.includes(socket.userId));
        
        userStreams.forEach(streamId => {
          const stream = activeStreams.get(streamId);
          logger.info(`Stopping stream to ${stream.platform} due to disconnect`, { userId: socket.userId });
          try {
            stream.process.kill('SIGTERM');
            activeStreams.delete(streamId);
          } catch (error) {
            logger.error(`Error stopping stream to ${stream.platform}:`, error);
          }
        });
      }
    });
  });
  
  return io;
}

module.exports = { setupSocketServer }; 