const mongoose = require('mongoose');
const crypto = require('crypto');

const RtmpDestinationSchema = new mongoose.Schema({
  streamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Stream',
    required: true
  },
  platform: {
    type: String,
    required: true,
    enum: ['youtube', 'facebook', 'twitch', 'custom']
  },
  name: {
    type: String,
    required: true
  },
  url: {
    type: String,
    required: true
  },
  streamKey: {
    type: String,
    required: true
  },
  active: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Encrypt stream keys before saving
RtmpDestinationSchema.pre('save', function(next) {
  if (this.isModified('streamKey')) {
    try {
      // Use environment variable for the encryption key
      const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY || 'defaultkeydefaultkey', 'utf8');
      const iv = crypto.randomBytes(16);
      
      const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
      let encrypted = cipher.update(this.streamKey, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      // Store the IV with the encrypted data for later decryption
      this.streamKey = `${iv.toString('hex')}:${encrypted}`;
    } catch (err) {
      return next(err);
    }
  }
  next();
});

// Add a method to decrypt stream keys when needed
RtmpDestinationSchema.methods.getDecryptedStreamKey = function() {
  try {
    const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY || 'defaultkeydefaultkey', 'utf8');
    const parts = this.streamKey.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = parts[1];
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (err) {
    console.error('Error decrypting stream key:', err);
    return null;
  }
};

module.exports = mongoose.model('RtmpDestination', RtmpDestinationSchema); 