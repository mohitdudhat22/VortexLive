const mongoose = require('mongoose');

const StreamSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  hostId: {
    type: String,
    required: true
  },
  active: {
    type: Boolean,
    default: true
  },
  roomId: {
    type: String,
    required: true,
    unique: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Check if the model exists before compiling it
module.exports = mongoose.models.Stream || mongoose.model('Stream', StreamSchema); 