// loop-stream-ffmpeg-live.js
// npm i @ffmpeg-installer/ffmpeg
// Usage examples (interactive prompt will also show these):
//  - file (default, looping): node loop-stream-ffmpeg-live.js
//  - live  (simulate incoming binary live stream to ffmpeg.stdin): node loop-stream-ffmpeg-live.js
//  - tcp   (listen for a single binary client): INPUT_MODE=tcp PORT=10000 node loop-stream-ffmpeg-live.js
//  - simulate-tcp-client (will connect locally and stream file repeatedly): node loop-stream-ffmpeg-live.js

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const readline = require('readline');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const STREAM_KEY = process.env.YOUTUBE_STREAM_KEY || 'ppxs-27vs-9375-xejb-8d36';
const RTMP_URL = `rtmps://a.rtmp.youtube.com:443/live2/${STREAM_KEY}`;

// NOTE: interactive prompt will override INPUT_MODE if provided on the command line only if you choose differently.
const ENV_INPUT_MODE = (process.env.INPUT_MODE || '').toLowerCase();
const FILENAME = process.env.FILENAME || 'input.mp4';
const PORT = parseInt(process.env.PORT || '10000', 10);

const INPUT_FORMAT = process.env.INPUT_FORMAT || ''; // e.g. 'mpegts' or 'flv' or 'mp4' or '' (auto)
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || '3500k';
const MAXRATE = process.env.MAXRATE || '4500k';
const BUFSIZE = process.env.BUFSIZE || '6000k';

let ffmpeg = null;
let restarting = false;
let tcpServer = null;
let currentClient = null;
let simulateTcpClientInterval = null;

function buildArgsForPipe() {
    const args = [];
    if (INPUT_FORMAT) args.push('-f', INPUT_FORMAT);
    args.push('-i', 'pipe:0');

    args.push(
        '-fflags', 'nobuffer',
        '-flags', '+low_delay',
        '-strict', 'experimental',

        // video encode
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-b:v', VIDEO_BITRATE,
        '-maxrate', MAXRATE,
        '-bufsize', BUFSIZE,
        '-pix_fmt', 'yuv420p',
        '-g', '60',

        // audio encode
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',

        '-f', 'flv',
        RTMP_URL
    );

    return args;
}

function spawnFFmpeg(args, stdio = ['pipe', 'pipe', 'pipe']) {
    console.log('⚡ Spawning ffmpeg with args:', args.join(' '));
    const proc = spawn(ffmpegPath, args, { stdio });

    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.stdout.on('data', (d) => process.stdout.write(d));

    proc.on('error', (err) => {
        console.error('🔥 ffmpeg spawn error:', err);
    });

    proc.on('close', (code, signal) => {
        console.log(`⚠️ ffmpeg exited code=${code} signal=${signal}`);
        ffmpeg = null;

        if (!restarting) {
            restarting = true;
            setTimeout(() => {
                restarting = false;
                if (currentMode === 'file') {
                    startFileLoop();
                } else {
                    // try fallback to file-loop automatically
                    switchToFileLoopIfAvailable();
                    console.log('ffmpeg stopped. Waiting for new input (stdin/tcp) or file fallback to run.');
                }
            }, 2000);
        }
    });

    return proc;
}

/* -----------------------------
Fallback helper
----------------------------- */
function switchToFileLoopIfAvailable() {
    if (ffmpeg) {
        console.log('ffmpeg already running; not switching to file loop.');
        return;
    }
    if (!fs.existsSync(FILENAME)) {
        console.log(`No fallback file "${FILENAME}" found. Staying idle and waiting for input.`);
        return;
    }
    console.log('🔁 Live input ended — switching to fallback infinite file loop:', FILENAME);
    currentMode = 'file';
    startFileLoop();
}

/* -----------------------------
Generic helpers for streaming files into ffmpeg.stdin (handles backpressure)
Used by file loop and live simulation.
----------------------------- */
function waitForDrain(stream) {
    return new Promise((resolve, reject) => {
        function onDrain() {
            cleanup();
            resolve();
        }
        function onError(err) {
            cleanup();
            reject(err);
        }
        function cleanup() {
            stream.removeListener('drain', onDrain);
            stream.removeListener('error', onError);
        }
        stream.once('drain', onDrain);
        stream.once('error', onError);
    });
}

async function streamFileOnceToStdin(filename, ffmpegProc, { chunkedDelayMs = 0 } = {}) {
    if (!ffmpegProc || !ffmpegProc.stdin) throw new Error('ffmpeg not ready');

    return new Promise((resolve, reject) => {
        const rs = fs.createReadStream(filename);
        rs.on('error', (err) => {
            rs.destroy();
            reject(err);
        });

        rs.on('end', () => {
            rs.destroy();
            resolve();
        });

        rs.on('data', async (chunk) => {
            if (!ffmpegProc || !ffmpegProc.stdin || ffmpegProc.stdin.destroyed) {
                rs.destroy();
                resolve();
                return;
            }

            const ok = ffmpegProc.stdin.write(chunk);
            if (!ok) {
                rs.pause();
                try {
                    await waitForDrain(ffmpegProc.stdin);
                } catch (err) {
                    rs.destroy();
                    reject(err);
                    return;
                }
                if (!rs.destroyed) rs.resume();
            }

            if (chunkedDelayMs > 0) {
                rs.pause();
                setTimeout(() => { if (!rs.destroyed) rs.resume(); }, chunkedDelayMs);
            }
        });

        // If ffmpeg stdin closes, cleanup and stop
        ffmpegProc.stdin.on('close', () => {
            rs.destroy();
            resolve();
        });
        ffmpegProc.stdin.on('error', (err) => {
            rs.destroy();
            reject(err);
        });
    });
}

/* -----------------------------
Mode: file (looping file) - infinite
----------------------------- */
async function startFileLoop() {
    if (ffmpeg) return;
    console.log('🔄 Mode=file (endless loop) — streaming file:', FILENAME);

    if (!fs.existsSync(FILENAME)) {
        console.error(`❌ Error: File "${FILENAME}" not found!`);
        console.log('Please provide a valid video file:');
        console.log(`  FILENAME=/path/to/video.mp4 node ${process.argv[1]}`);
        if (currentMode === 'file') process.exit(1);
        return;
    }

    const args = buildArgsForPipe();
    ffmpeg = spawnFFmpeg(args, ['pipe', 'pipe', 'pipe']);

    try {
        let loopCount = 0;
        // pump in a loop (honors backpressure)
        while (ffmpeg && ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
            loopCount++;
            console.log(`🔁 [file-loop] iteration #${loopCount}`);
            await streamFileOnceToStdin(FILENAME, ffmpeg);
            // yield to event loop
            await new Promise(r => setImmediate(r));
        }
    } catch (err) {
        console.error('pumpFileToStdin error:', err);
        try { if (ffmpeg) ffmpeg.kill('SIGINT'); } catch (e) { }
        ffmpeg = null;
    }

    setupProcessShutdown();
}

/* -----------------------------
Mode: live (simulate incoming binary live stream)
This will emulate a client streaming binary chunks to ffmpeg.stdin.
It repeatedly streams the file (so the live feed appears continuous) but
uses stream semantics (not the file-loop mode) so behavior follows stdin/tcp code paths.
----------------------------- */
async function startLiveSimulation() {
    if (ffmpeg) return;
    console.log('📡 Mode=live — simulating an incoming binary live stream (piping repeated file to ffmpeg.stdin)');

    if (!fs.existsSync(FILENAME)) {
        console.error(`❌ Error: File "${FILENAME}" not found!`);
        return;
    }

    const args = buildArgsForPipe();
    ffmpeg = spawnFFmpeg(args, ['pipe', 'pipe', 'pipe']);

    // Simulation parameters (tweak to your taste)
    const chunkedDelayMs = 0;     // per-chunk artificial pause (ms) to simulate network chunking
    const betweenLoopDelayMs = 200; // delay between repeated file loops (ms)

    try {
        let iteration = 0;
        while (ffmpeg && ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
            iteration++;
            console.log(`🔁 [live-sim] streaming pass #${iteration}`);
            await streamFileOnceToStdin(FILENAME, ffmpeg, { chunkedDelayMs });
            // small pause between passes to simulate a slight gap like a live source might have
            await new Promise(resolve => setTimeout(resolve, betweenLoopDelayMs));
        }
    } catch (err) {
        console.error('live simulation error:', err);
        try { if (ffmpeg) ffmpeg.kill('SIGINT'); } catch (e) { }
        ffmpeg = null;
    }

    setupProcessShutdown();
}

/* -----------------------------
Mode: stdin (real STDIN piping)
----------------------------- */
function startStdinMode() {
    if (ffmpeg) return;
    console.log('Mode=stdin — reading binary from STDIN (pipe:0)');

    const args = buildArgsForPipe();
    ffmpeg = spawnFFmpeg(args, ['pipe', 'pipe', 'pipe']);

    process.stdin.setEncoding(null);
    process.stdin.pipe(ffmpeg.stdin);

    process.stdin.on('end', () => {
        console.log('STDIN ended — attempting fallback to file-loop (if available).');
        if (ffmpeg && ffmpeg.stdin) {
            try { ffmpeg.stdin.end(); } catch (e) {}
        }
        setTimeout(() => switchToFileLoopIfAvailable(), 500);
    });

    setupProcessShutdown();
}

/* -----------------------------
Mode: tcp (listen for one client), unchanged but kept explicit
----------------------------- */
function startTcpMode() {
    if (tcpServer) return;
    console.log(`Mode=tcp — listening on port ${PORT} for a single binary client.`);

    tcpServer = net.createServer((socket) => {
        if (currentClient) {
            console.log('Rejecting additional connection: already have a client.');
            socket.end();
            return;
        }

        console.log('TCP client connected from', socket.remoteAddress, socket.remotePort);
        currentClient = socket;

        if (!ffmpeg) {
            const args = buildArgsForPipe();
            ffmpeg = spawnFFmpeg(args, ['pipe', 'pipe', 'pipe']);
        }

        socket.pipe(ffmpeg.stdin, { end: false });

        socket.on('close', () => {
            console.log('TCP client disconnected.');
            currentClient = null;
            if (ffmpeg && ffmpeg.stdin) {
                try { ffmpeg.stdin.end(); } catch (e) { }
            }
            setTimeout(() => {
                if (ffmpeg) {
                    try { ffmpeg.kill('SIGINT'); } catch (e) { }
                    ffmpeg = null;
                }
                switchToFileLoopIfAvailable();
            }, 500);
        });

        socket.on('error', (err) => {
            console.error('TCP client socket error:', err);
            socket.destroy();
            currentClient = null;
            switchToFileLoopIfAvailable();
        });
    });

    tcpServer.on('error', (err) => {
        console.error('TCP server error:', err);
    });

    tcpServer.listen(PORT, () => {
        console.log(`TCP server listening on ${PORT}`);
    });

    setupProcessShutdown();
}

/* -----------------------------
Simulated TCP client (for testing tcp mode). It connects to localhost:PORT
and repeatedly streams the file to the server socket like a live client.
----------------------------- */
function startSimulatedTcpClient(targetPort = PORT, host = '127.0.0.1') {
    if (!fs.existsSync(FILENAME)) {
        console.error(`Cannot simulate TCP client: file "${FILENAME}" not found.`);
        return;
    }
    console.log(`🤖 Starting simulated TCP client -> ${host}:${targetPort}. Will repeatedly stream ${FILENAME}`);

    function streamOnceToSocket(socket) {
        return new Promise((resolve, reject) => {
            const rs = fs.createReadStream(FILENAME);
            rs.on('error', (err) => {
                rs.destroy();
                reject(err);
            });
            rs.on('end', () => {
                rs.destroy();
                resolve();
            });
            rs.pipe(socket, { end: false });
        });
    }

    const socket = new net.Socket();
    socket.connect(targetPort, host, async () => {
        console.log('Simulated client connected.');
        try {
            while (!socket.destroyed) {
                console.log('🔁 [sim-client] streaming a pass to server...');
                await streamOnceToSocket(socket);
                await new Promise(r => setTimeout(r, 200)); // small gap between passes
            }
        } catch (err) {
            console.error('Simulated client streaming error:', err);
            socket.destroy();
        }
    });

    socket.on('close', () => console.log('Simulated client connection closed.'));
    socket.on('error', (err) => console.error('Simulated client socket err:', err));
    // keep a ref if we want to stop it later
    simulateTcpClientInterval = socket;
}

/* -----------------------------
Shutdown helpers
----------------------------- */
function setupProcessShutdown() {
    function shutdown() {
        console.log('Shutting down: cleaning up ffmpeg and sockets...');
        if (simulateTcpClientInterval) {
            try { simulateTcpClientInterval.destroy(); } catch (e) {}
            simulateTcpClientInterval = null;
        }
        if (currentClient) {
            try { currentClient.end(); } catch (e) {}
            currentClient = null;
        }
        if (tcpServer) {
            try { tcpServer.close(); } catch (e) {}
            tcpServer = null;
        }
        if (ffmpeg) {
            try { ffmpeg.kill('SIGINT'); } catch (e) {}
            ffmpeg = null;
        }
        setTimeout(() => process.exit(0), 1200);
    }

    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

/* -----------------------------
Interactive CLI & startup
----------------------------- */
let currentMode = ENV_INPUT_MODE || '';

function printRunExamples() {
    console.log('\nExamples (shell):');
    console.log('  # file mode (looping):');
    console.log(`  FILENAME=${FILENAME} node ${process.argv[1]}`);
    console.log('  # live simulation (simulate incoming binary live stream):');
    console.log(`  node ${process.argv[1]}  # choose "live" when prompted`);
    console.log('  # tcp server (listen for client):');
    console.log(`  INPUT_MODE=tcp PORT=${PORT} node ${process.argv[1]}`);
    console.log('  # simulate a tcp client that streams the file repeatedly (run in another terminal):');
    console.log(`  node ${process.argv[1]}  # choose "simulate-tcp-client" when prompted`);
    console.log('');
}

async function askModeAndRunIfNeeded() {
    if (currentMode && ['file', 'stdin', 'tcp', 'live', 'simulate-tcp-client'].includes(currentMode)) {
        // env-specified mode is valid; run directly
        return startSelectedMode(currentMode);
    }

    printRunExamples();

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    function question(q) {
        return new Promise(resolve => rl.question(q, ans => resolve(ans && ans.trim())));
    }

    const ans = (await question('Choose mode to run [file | live | stdin | tcp | simulate-tcp-client] (file): ')) || 'file';
    rl.close();

    currentMode = ans;
    return startSelectedMode(ans);
}

function startSelectedMode(mode) {
    mode = (mode || 'file').toLowerCase();
    if (mode === 'file') {
        currentMode = 'file';
        startFileLoop();
    } else if (mode === 'live') {
        currentMode = 'live';
        startLiveSimulation();
    } else if (mode === 'stdin') {
        currentMode = 'stdin';
        if (process.stdin.isTTY) {
            console.warn('Warning: STDIN is TTY. Make sure you pipe binary data into this process.');
        }
        startStdinMode();
    } else if (mode === 'tcp') {
        currentMode = 'tcp';
        startTcpMode();
    } else if (mode === 'simulate-tcp-client') {
        // starts the server and then the simulated client in same process for convenience
        console.log('Starting local TCP server + simulated client for testing.');
        startTcpMode();
        // give server a moment to start
        setTimeout(() => startSimulatedTcpClient(PORT, '127.0.0.1'), 300);
    } else {
        console.error('Unknown mode:', mode);
        process.exit(2);
    }
}

/* -----------------------------
Initialize
----------------------------- */
askModeAndRunIfNeeded().catch(err => {
    console.error('Startup error:', err);
    process.exit(1);
});
