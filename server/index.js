const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const dotenv = require('dotenv');
const Stream = require('./models/Stream');
const RtmpDestination = require('./models/RtmpDestination');
const { spawn } = require('child_process');
const fs = require('fs');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Add this middleware for streams routes
app.use('/api/streams', require('./routes/streams'));

// Add RTMP routes
app.use('/api/rtmp', require('./routes/rtmp'));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/streamingApp')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// In-memory storage for chat messages and muted users
const chatMessages = {};
const mutedUsers = {};

// In-memory storage for active FFmpeg processes
const ffmpegProcesses = {};

// Socket.io logic for handling WebRTC signaling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Join a room
  socket.on('join-room', (roomId, userId) => {
    socket.join(roomId);
    console.log(`User ${userId} joined room ${roomId}`);
    
    // Notify other users in the room
    socket.to(roomId).emit('user-connected', userId);

    // Handle when user disconnects
    socket.on('disconnect', () => {
      console.log(`User ${userId} disconnected`);
      socket.to(roomId).emit('user-disconnected', userId);
    });
  });

  // Signal handling for WebRTC - FIX HERE
  socket.on('signal', ({ userId, roomId, signal, targetUserId }) => {
    console.log(`Signal from ${userId} to ${targetUserId || 'room'} in ${roomId}`);
    
    // If targetUserId is provided, send signal directly to that user
    if (targetUserId) {
      // Find the target user's socket and send the signal only to them
      const clients = io.sockets.adapter.rooms.get(roomId);
      if (clients) {
        for (const clientId of clients) {
          const clientSocket = io.sockets.sockets.get(clientId);
          if (clientSocket && clientSocket.userId === targetUserId) {
            clientSocket.emit('user-signal', { userId, signal });
            return;
          }
        }
      }
    }
    
    // Otherwise, send to all other users in the room (excluding sender)
    socket.to(roomId).emit('user-signal', { userId, signal });
  });
  
  // Store userId in socket object for later retrieval
  socket.on('register-user', ({ userId }) => {
    socket.userId = userId;
    console.log(`Registered socket ${socket.id} for user ${userId}`);
  });

  // Add this to your Socket.io event handlers
  socket.on('get-host-id', async ({ roomId }) => {
    try {
      // Get the host ID for this room from the database
      const stream = await Stream.findOne({ roomId, active: true });
      
      if (stream) {
        socket.emit('host-id', stream.hostId);
      } else {
        console.log(`No active stream found for room ${roomId}`);
      }
    } catch (error) {
      console.error('Error getting host ID:', error);
    }
  });

  // Chat messaging
  socket.on('send-chat-message', (messageData) => {
    // Broadcast message to everyone in the room except sender
    socket.to(messageData.roomId).emit('chat-message', messageData);
    
    // Store chat messages in memory (optional - can be expanded to database)
    if (!chatMessages[messageData.roomId]) {
      chatMessages[messageData.roomId] = [];
    }
    
    // Keep only last 100 messages per room
    chatMessages[messageData.roomId].push(messageData);
    if (chatMessages[messageData.roomId].length > 100) {
      chatMessages[messageData.roomId].shift();
    }
  });

  // Send chat history when user joins room
  socket.on('get-chat-history', ({ roomId }) => {
    if (chatMessages[roomId]) {
      socket.emit('chat-history', chatMessages[roomId]);
    }
  });

  // Message reactions
  socket.on('add-reaction', (reactionData) => {
    socket.to(reactionData.roomId).emit('message-reaction', reactionData);
  });

  // Message deletion
  socket.on('delete-message', ({ messageId, roomId, userId }) => {
    // Optionally verify that the user is allowed to delete this message
    // For example, check if user is host or message author
    
    // If using DB storage, delete from database here
    
    // Notify all clients about deleted message
    io.to(roomId).emit('message-deleted', messageId);
    
    // Update in-memory storage if using
    if (chatMessages[roomId]) {
      chatMessages[roomId] = chatMessages[roomId].filter(msg => msg.id !== messageId);
    }
  });

  // User muting
  socket.on('mute-user', async ({ roomId, userId, targetUserId, targetUsername }) => {
    // Check if requester is the host
    const stream = await Stream.findOne({ roomId, hostId: userId });
    if (stream) {
      // Store muted user in a set or database
      if (!mutedUsers[roomId]) {
        mutedUsers[roomId] = new Set();
      }
      mutedUsers[roomId].add(targetUserId);
      
      // Optional: Broadcast to all moderators that user was muted
      // This could be used to sync mute state across host devices
      socket.to(roomId).emit('user-muted', { targetUserId, targetUsername });
    }
  });

  // Add RTMP control events
  socket.on('start-rtmp-stream', async ({ roomId, userId, destinations }) => {
    try {
      console.log(`Starting RTMP stream for room ${roomId}, user ${userId}`);
      console.log('Destinations:', destinations);
      
      // Validate destinations
      if (!destinations || destinations.length === 0) {
        socket.emit('rtmp-stream-error', { 
          success: false, 
          message: 'No streaming destinations provided' 
        });
        return;
      }
      
      const streamSourceUrl = `http://localhost:${PORT}/api/streams/${roomId}/source`;
      console.log(`Using stream source: ${streamSourceUrl}`);
      
      // Process each destination
      destinations.forEach(destination => {
        if (!destination.streamKey || !destination.url) {
          socket.emit('rtmp-stream-error', { 
            success: false, 
            message: `Missing required data for ${destination.platform} stream` 
          });
          return;
        }
        
        // Use the installed FFmpeg path
        console.log(`Using FFmpeg at: ${ffmpegPath}`);
        const ffmpeg = spawn(ffmpegPath, [
          '-i', streamSourceUrl,
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-maxrate', '3000k',
          '-bufsize', '6000k',
          '-framerate', '30',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          '-f', 'flv',
          `${destination.url}/${destination.streamKey}`
        ]);
        
        // Handle process events
        ffmpeg.stdout.on('data', (data) => {
          console.log(`FFmpeg stdout (${destination.platform}): ${data}`);
        });
        
        ffmpeg.stderr.on('data', (data) => {
          console.log(`FFmpeg stderr (${destination.platform}): ${data}`);
        });
        
        ffmpeg.on('error', (error) => {
          console.error(`FFmpeg error (${destination.platform}):`, error);
          socket.emit('rtmp-stream-error', { 
            success: false, 
            message: `Streaming error: ${error.message}`, 
            platform: destination.platform 
          });
        });
        
        ffmpeg.on('close', (code) => {
          console.log(`FFmpeg process for ${destination.platform} exited with code ${code}`);
          if (code !== 0) {
            socket.emit('rtmp-stream-error', { 
              success: false, 
              message: `Stream ended with code ${code}`, 
              platform: destination.platform 
            });
          }
        });
        
        // Store the process for potential termination
        socket.ffmpegProcesses = socket.ffmpegProcesses || [];
        socket.ffmpegProcesses.push({
          process: ffmpeg,
          platform: destination.platform
        });
      });
      
      socket.emit('rtmp-stream-started', { 
        success: true, 
        message: 'Stream started successfully' 
      });
      
    } catch (error) {
      console.error('Error in start-rtmp-stream:', error);
      socket.emit('rtmp-stream-error', { 
        success: false, 
        message: `Server error: ${error.message}` 
      });
    }
  });
  
  // Handle cleanup on disconnect
  socket.on('disconnect', () => {
    if (socket.ffmpegProcesses && socket.ffmpegProcesses.length > 0) {
      console.log(`Cleaning up ${socket.ffmpegProcesses.length} FFmpeg processes`);
      socket.ffmpegProcesses.forEach(({ process, platform }) => {
        try {
          process.kill('SIGTERM');
          console.log(`Terminated FFmpeg process for ${platform}`);
        } catch (err) {
          console.error(`Error terminating FFmpeg process for ${platform}:`, err);
        }
      });
    }
  });

  // Add this to your socket.io event handlers
  socket.on('get-external-streaming-status', async ({ roomId }) => {
    try {
      const stream = await Stream.findOne({ roomId, active: true });
      
      if (stream) {
        // Get active platforms
        const activePlatforms = Object.keys(ffmpegProcesses[roomId] || {});
        
        // Send status to client
        socket.emit('external-streaming-status', { 
          active: activePlatforms.length > 0, 
          platforms: activePlatforms 
        });
      } else {
        socket.emit('external-streaming-status', { 
          active: false, 
          platforms: [] 
        });
      }
    } catch (error) {
      console.error('Error getting external streaming status:', error);
      socket.emit('external-streaming-status', { 
        active: false, 
        platforms: [], 
        error: error.message 
      });
    }
  });
});

// FFmpeg helper functions
async function startRtmpStreams(roomId, destinations) {
  const PORT = process.env.PORT || 5000;
  
  if (!ffmpegProcesses[roomId]) {
    ffmpegProcesses[roomId] = {};
  }
  
  const activeStreams = [];
  
  for (const dest of destinations) {
    try {
      // Make sure we have the required data
      if (!dest.platform || !dest.streamKey || !dest.url) {
        console.error(`Missing required data for ${dest.platform} stream`);
        continue;
      }
      
      // Different platforms might need different FFmpeg parameters
      const inputSource = `http://localhost:${PORT}/api/streams/${roomId}/source`;
      let rtmpUrl = '';
      
      switch (dest.platform) {
        case 'youtube':
          rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${dest.streamKey}`;
          break;
        case 'facebook':
          rtmpUrl = `rtmp://live-api-s.facebook.com:80/rtmp/${dest.streamKey}`;
          break;
        case 'twitch':
          rtmpUrl = `rtmp://live.twitch.tv/app/${dest.streamKey}`;
          break;
        default:
          rtmpUrl = dest.url;
      }
      
      // Update clients that we're connecting
      io.to(roomId).emit('rtmp-platform-status', {
        platform: dest.platform,
        status: 'connecting'
      });
      
      // Use ffmpegPath instead of 'ffmpeg'
      console.log(`Using FFmpeg at: ${ffmpegPath}`);
      const ffmpeg = spawn(ffmpegPath, [
        '-i', inputSource,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-maxrate', '3000k',
        '-bufsize', '6000k',
        '-framerate', '30',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-f', 'flv',
        rtmpUrl
      ]);
      
      // Add a timeout to check if connection was successful
      const connectionTimeout = setTimeout(() => {
        // If process is still running after 5 seconds, consider it connected
        if (ffmpegProcesses[roomId]?.[dest.platform]) {
          io.to(roomId).emit('rtmp-platform-status', {
            platform: dest.platform,
            status: 'connected'
          });
        }
      }, 5000);
      
      // Log output for debugging
      ffmpeg.stdout.on('data', (data) => {
        console.log(`FFmpeg (${dest.platform}) stdout: ${data}`);
      });
      
      ffmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        console.log(`FFmpeg (${dest.platform}) stderr: ${output}`);
        
        // Check for common error patterns
        if (output.includes('Connection refused') || 
            output.includes('Invalid argument') || 
            output.includes('Authorization failed')) {
          
          // Emit error to client
          io.to(roomId).emit('rtmp-platform-status', {
            platform: dest.platform,
            status: 'error',
            error: 'Connection failed. Please check your stream key.'
          });
          
          // Kill the process
          ffmpeg.kill('SIGTERM');
          if (ffmpegProcesses[roomId]?.[dest.platform]) {
            delete ffmpegProcesses[roomId][dest.platform];
          }
          
          clearTimeout(connectionTimeout);
        }
      });
      
      ffmpeg.on('close', (code) => {
        console.log(`FFmpeg process for ${dest.platform} exited with code ${code}`);
        if (ffmpegProcesses[roomId]?.[dest.platform]) {
          delete ffmpegProcesses[roomId][dest.platform];
        }
      });
      
      // Store process reference
      ffmpegProcesses[roomId][dest.platform] = ffmpeg;
      
      // Track active stream
      activeStreams.push({
        platform: dest.platform,
        active: true
      });
    } catch (error) {
      console.error(`Error starting ${dest.platform} stream:`, error);
      
      io.to(roomId).emit('rtmp-platform-status', {
        platform: dest.platform,
        status: 'error',
        error: error.message
      });
    }
  }
  
  return activeStreams;
}

function stopRtmpStream(roomId, platform) {
  if (!ffmpegProcesses[roomId]) {
    return { success: false, message: 'No active streams for this room' };
  }
  
  // If platform specified, stop only that stream
  if (platform && ffmpegProcesses[roomId][platform]) {
    ffmpegProcesses[roomId][platform].kill('SIGTERM');
    delete ffmpegProcesses[roomId][platform];
    return { success: true, message: `Stopped ${platform} stream` };
  } 
  // Otherwise stop all streams for this room
  else if (!platform) {
    Object.keys(ffmpegProcesses[roomId]).forEach(p => {
      ffmpegProcesses[roomId][p].kill('SIGTERM');
    });
    delete ffmpegProcesses[roomId];
    return { success: true, message: 'Stopped all streams' };
  }
  
  return { success: false, message: 'Stream not found' };
}

// Clean up FFmpeg processes on server shutdown
process.on('SIGINT', () => {
  console.log('Shutting down, cleaning up FFmpeg processes...');
  Object.keys(ffmpegProcesses).forEach(roomId => {
    Object.keys(ffmpegProcesses[roomId]).forEach(platform => {
      ffmpegProcesses[roomId][platform].kill('SIGTERM');
    });
  });
  process.exit(0);
});

// API Routes
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 