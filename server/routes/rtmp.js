const express = require('express');
const router = express.Router();
const Stream = require('../models/Stream');
const RtmpDestination = require('../models/RtmpDestination');

// Get all RTMP destinations for a stream
router.get('/destinations/:streamId', async (req, res) => {
  try {
    const destinations = await RtmpDestination.find({ streamId: req.params.streamId });
    res.json(destinations);
  } catch (error) {
    console.error('Error fetching RTMP destinations:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add a new RTMP destination
router.post('/destinations', async (req, res) => {
  try {
    const { streamId, platform, name, url, streamKey } = req.body;
    
    // Validate the stream exists
    const stream = await Stream.findById(streamId);
    if (!stream) {
      return res.status(404).json({ message: 'Stream not found' });
    }
    
    const destination = new RtmpDestination({
      streamId,
      platform,
      name,
      url,
      streamKey
    });
    
    await destination.save();
    res.status(201).json(destination);
  } catch (error) {
    console.error('Error creating RTMP destination:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update an RTMP destination
router.put('/destinations/:id', async (req, res) => {
  try {
    const { active } = req.body;
    
    const destination = await RtmpDestination.findByIdAndUpdate(
      req.params.id,
      { active },
      { new: true }
    );
    
    if (!destination) {
      return res.status(404).json({ message: 'Destination not found' });
    }
    
    res.json(destination);
  } catch (error) {
    console.error('Error updating RTMP destination:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete an RTMP destination
router.delete('/destinations/:id', async (req, res) => {
  try {
    const destination = await RtmpDestination.findByIdAndDelete(req.params.id);
    
    if (!destination) {
      return res.status(404).json({ message: 'Destination not found' });
    }
    
    res.json({ message: 'Destination deleted' });
  } catch (error) {
    console.error('Error deleting RTMP destination:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get platform status
router.get('/status/:roomId', async (req, res) => {
  try {
    const stream = await Stream.findOne({ roomId: req.params.roomId, active: true });
    
    if (!stream) {
      return res.status(404).json({ message: 'Active stream not found' });
    }
    
    const destinations = await RtmpDestination.find({ 
      streamId: stream._id,
      active: true
    });
    
    res.json({
      active: destinations.length > 0,
      platforms: destinations.map(d => d.platform)
    });
  } catch (error) {
    console.error('Error getting RTMP status:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router; 