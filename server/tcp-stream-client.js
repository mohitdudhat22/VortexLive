// tcp-stream-client.js
// Usage: node tcp-stream-client.js [host] [port] [file]
// Defaults: host=127.0.0.1 port=10000 file=./input.mp4

const net = require('net');
const fs = require('fs');
const path = require('path');

const HOST = process.argv[2] || '127.0.0.1';
const PORT = parseInt(process.argv[3] || '10000', 10);
const FILE = process.argv[4] || path.join(process.cwd(), 'input.mp4');

let socket = null;
let shouldStop = false;

function startStreamingLoop() {
  if (!fs.existsSync(FILE)) {
    console.error('File not found:', FILE);
    process.exit(1);
  }

  function streamOnce() {
    if (!socket || socket.destroyed) return;

    const rs = fs.createReadStream(FILE, { highWaterMark: 64 * 1024 });
    rs.on('error', (err) => {
      console.error('ReadStream error:', err);
      socket.end();
    });

    // Pipe file to socket. When file ends, create a new readstream and pipe again.
    rs.pipe(socket, { end: false });

    rs.on('end', () => {
      // Small tick to avoid tight loop; you can change delay if needed
      setImmediate(() => {
        if (!shouldStop && socket && !socket.destroyed) {
          streamOnce();
        }
      });
    });
  }

  streamOnce();
}

function connect() {
  socket = net.createConnection({ host: HOST, port: PORT }, () => {
    console.log(`Connected to ${HOST}:${PORT} — streaming ${FILE} in loop`);
    startStreamingLoop();
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
  });

  socket.on('close', (hadError) => {
    console.log('Socket closed', hadError ? 'due to error' : '');
    if (!shouldStop) {
      console.log('Reconnecting in 2s...');
      setTimeout(connect, 2000);
    }
  });

  // Optional: catch backpressure on socket (just log)
  socket.on('drain', () => {
    // socket buffer drained, resume occurs automatically for pipe
    // useful for monitoring
  });
}

process.on('SIGINT', () => {
  console.log('Stopping client...');
  shouldStop = true;
  if (socket) socket.end();
  setTimeout(() => process.exit(0), 500);
});

connect();
