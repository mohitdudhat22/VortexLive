// middleware/index.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const logger = require('../utils/logger');

const applyMiddlewares = (app) => {
  app.use(cors());
  app.use(express.json());
  app.use(morgan(':method :url :status :response-time ms', {
    stream: { write: msg => logger.http(msg.trim()) }
  }));
};

module.exports = applyMiddlewares;
