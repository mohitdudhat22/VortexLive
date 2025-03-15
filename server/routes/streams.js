const express = require('express');
const router = express.Router();
const Stream = require('../models/Stream');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
// Create a new stream
router.post('/', async (req, res) => {
  try {
    const { title, hostId } = req.body;
    
    const stream = new Stream({
      title,
      hostId,
      roomId: uuidv4()
    });

    await stream.save();
    res.status(201).json(stream);
  } catch (error) {
    console.error('Error creating stream:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all active streams
router.get('/', async (req, res) => {
  try {
    const streams = await Stream.find({ active: true }).sort({ createdAt: -1 });
    res.json(streams);
  } catch (error) {
    console.error('Error fetching streams:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get stream by ID
router.get('/:id', async (req, res) => {
  try {
    const stream = await Stream.findById(req.params.id);
    if (!stream) {
      return res.status(404).json({ message: 'Stream not found' });
    }
    res.json(stream);
  } catch (error) {
    console.error('Error fetching stream:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// End a stream
router.patch('/:id/end', async (req, res) => {
  try {
    const stream = await Stream.findByIdAndUpdate(
      req.params.id,
      { active: false },
      { new: true }
    );
    
    if (!stream) {
      return res.status(404).json({ message: 'Stream not found' });
    }
    
    res.json(stream);
  } catch (error) {
    console.error('Error ending stream:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add this new route to provide the stream source for FFmpeg
router.get('/:roomId/source', async (req, res) => {
  try {
    const { roomId } = req.params;
    
    // Check if room exists and is active
    const stream = await Stream.findOne({ roomId, active: true });
    if (!stream) {
      return res.status(404).send('Stream not found or inactive');
    }

    // Set appropriate headers for video streaming
    res.setHeader('Content-Type', 'video/webm');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache');
    
    // Here you'd need to pipe the WebRTC stream data to this response
    // This could be implemented using a WebRTC gateway or media server
    // For simplicity, we'll mock a response here
    
    // In a real implementation, you'd get the stream from your media server
    // For example, using mediasoup, Janus, or other WebRTC SFU/MCU
    const mediaServerStreamUrl = `https://your-media-server.com/streams/${roomId}`;
    
    // You could use another FFmpeg instance to pull from your WebRTC server
    // and pipe to this response
    const ffmpeg = spawn(ffmpegPath, [
      '-i', mediaServerStreamUrl,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-f', 'webm',
      '-'
    ]);
    
    ffmpeg.stdout.pipe(res);
    
    ffmpeg.stderr.on('data', (data) => {
      console.log(`FFmpeg stderr: ${data}`);
    });
    
    req.on('close', () => {
      ffmpeg.kill('SIGTERM');
    });
    
  } catch (error) {
    console.error('Error serving stream source:', error);
    res.status(500).send('Server error');
  }
});

module.exports = router; 