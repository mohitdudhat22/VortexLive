const express = require('express');
const http = require('http');
const dotenv = require('dotenv');
const logger = require('./utils/logger');
const connectDB = require('./db');
const applyMiddlewares = require('./middleware');

dotenv.config();

const app = express();
const apiRoutes = require('./routes'); 
const { PORT } = require('./utils/constants.js');
const SocketManager = require('./socket/SocketManager');
const errorHandler = require('./middleware/errorHandler');
const server = http.createServer(app);

connectDB();
applyMiddlewares(app);

// Use bundled API routes
app.use('/api/v1', apiRoutes);

new SocketManager(server);

// Global error handler
app.use(errorHandler);

server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});