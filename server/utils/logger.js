// logger.js
const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

const { combine, timestamp, printf, errors, json, colorize, align, splat, metadata } = format;

// ✨ Custom console formatter with timestamp, level, message, stack & metadata
const consoleFormat = printf(({ timestamp, level, message, stack, metadata }) => {
  const meta = metadata && Object.keys(metadata).length ? `\n  meta: ${JSON.stringify(metadata, null, 2)}` : '';
  if (stack) return `${timestamp} [${level}] ${message}\n  ${stack}${meta}`;
  return `${timestamp} [${level}] ${message}${meta}`;
});

// 🧠 Console transport – colorful, detailed, dev-friendly
const transportConsole = new transports.Console({
  level: process.env.LOG_LEVEL || 'debug',
  handleExceptions: true,
  handleRejections: true,
  format: combine(
    colorize({ all: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    splat(),             // supports printf-style formatting (%s, %d, etc.)
    errors({ stack: true }),
    metadata({ fillExcept: ['message', 'level', 'timestamp', 'stack'] }),
    align(),
    consoleFormat
  )
});

// 💾 File transport – JSON structured for analysis & rotation
const transportFile = new transports.DailyRotateFile({
  level: process.env.LOG_LEVEL || 'debug',
  filename: 'logs/app-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '50m',
  maxFiles: '30d',
  format: combine(
    errors({ stack: true }),
    timestamp(),
    metadata({ fillExcept: ['message', 'level', 'timestamp', 'stack'] }),
    json()
  )
});

// 🚀 Create logger
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  format: combine(errors({ stack: true }), timestamp()),
  transports: [transportConsole, transportFile],
  exceptionHandlers: [
    new transports.File({ filename: 'logs/exceptions.log' }),
    transportConsole
  ],
  rejectionHandlers: [
    new transports.File({ filename: 'logs/rejections.log' }),
    transportConsole
  ],
  exitOnError: false
});

module.exports = logger;
