// logger.js
const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

const { combine, timestamp, printf, errors, json } = format;

const logFormat = printf(({ timestamp, level, message, stack, ...meta }) => {
  if (stack) return `${timestamp} ${level}: ${stack}`; // error stack
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level}: ${message}${metaStr}`;
});

const transportConsole = new transports.Console({
  format: combine(timestamp(), format.colorize(), logFormat)
});

const transportFile = new transports.DailyRotateFile({
  filename: 'logs/app-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
  format: combine(timestamp(), json())
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }), // <-- captures stack in error objects
    timestamp(),
    json()
  ),
  transports: [transportFile, transportConsole],
  exceptionHandlers: [
    new transports.File({ filename: 'logs/exceptions.log' })
  ],
  rejectionHandlers: [
    new transports.File({ filename: 'logs/rejections.log' })
  ],
  exitOnError: false
});

module.exports = logger;
