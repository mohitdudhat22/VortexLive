const express = require('express');
const router = express.Router();
const Stream = require('../models/Stream');
const { v4: uuidv4 } = require('uuid');

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

module.exports = router; 