const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const dotenv = require('dotenv');
const Stream = require('./models/Stream');

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

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/streamingApp')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

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
});

// API Routes
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 