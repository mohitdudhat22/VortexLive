const express = require('express');
const streamsRoutes = require('./streams');
const rtmpRoutes = require('./rtmp');

const router = express.Router();

// Mount all route modules
router.use('/streams', streamsRoutes);
router.use('/rtmp', rtmpRoutes);

router.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

module.exports = router;
