// middleware/errorHandler.js
const logger = require('../utils/logger'); // optional custom logger

const errorHandler = (err, req, res, next) => {
  // Log the error
  if (logger && logger.error) {
    logger.error('Unhandled error', {
      message: err.message,
      stack: err.stack,
    });
    console.log(Error)
  } else {
    console.error('Unhandled error:', err);
  }

  // Send generic response
  res.status(500).send('Internal Server Error');
};

module.exports = errorHandler;
