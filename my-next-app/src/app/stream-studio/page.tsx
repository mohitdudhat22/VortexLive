// @ts-nocheck
'use client'
import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import ChatPanel from '../../components/ChatPanel';
import RtmpControls from '../../components/RtmpControls';
import { NEXT_PUBLIC_API_BASE_URL, NEXT_PUBLIC_API_URL } from '@/src/utils/constants';
import { createStream, markStream } from './../../api/stream';
import { hideLoadingState, showLoadingState } from './index';

const StreamStudio = () => {
  const [title, setTitle] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [stream, setStream] = useState(null);
  const [streamData, setStreamData] = useState(null);
  const [peers, setPeers] = useState([]);
  const [viewerCount, setViewerCount] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);
  const [videoError, setVideoError] = useState(null);
  const [hostId, setHostId] = useState(null);
  const [isStreamingToBackend, setIsStreamingToBackend] = useState(false);
  const [backpressureStatus, setBackpressureStatus] = useState({
    isPaused: false,
    pausedAt: null,
    resumedAt: null
  });
  const pendingChunksRef = useRef([]);
  const maxPendingChunks = 100; // Max chunks to buffer locally

  // refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const socketRef = useRef<any>(null);
  const peersRef = useRef([]);
  const playTokenRef = useRef(0);

  // latest-state refs to avoid stale closures
  const streamRef = useRef(null);
  const streamDataRef = useRef(null);
  const mediaRecorderRef = useRef(null);

  useEffect(() => {
    let storedId = localStorage.getItem('userId');
    if (!storedId) {
      storedId = uuidv4();
      localStorage.setItem('userId', storedId);
    }
    setHostId(storedId);
  }, []);

  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  useEffect(() => {
    streamDataRef.current = streamData;
  }, [streamData]);

  useEffect(() => {
    if (!localStorage.getItem('userId') && hostId) {
      localStorage.setItem('userId', hostId);
    }
  }, [hostId]);

  function getMediaRecorderOptions() {
    const codecs = [
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm'
    ];

    const mimeType = codecs.find(t => {
      try {
        return MediaRecorder.isTypeSupported(t);
      } catch {
        return false;
      }
    }) || codecs[codecs.length - 1];

    return {
      mimeType,
      videoBitsPerSecond: 200_000,  // 200 kbps for video (lowered)
      audioBitsPerSecond: 32_000    // 32 kbps for audio
    };
  }

  // Get camera on mount (but only if no stream)
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!streamRef.current) {
        try {
          const ms = await getVideoStream();
          if (mounted) {
            setStream(ms);
          }
        } catch (err) {
          console.error('Initial camera setup failed:', err);
        }
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Robust attach: attaches stream to <video> and handles play races + user-interaction fallback
  useEffect(() => {
    const vid = videoRef.current;
    const currentStream = stream;
    if (!vid || !currentStream) return;

    const myToken = ++playTokenRef.current;
    let cleanedUp = false;

    // prepare video element
    try {
      vid.muted = true;
      vid.playsInline = true;
      vid.autoplay = false; // we'll call play programmatically
      vid.style.objectFit = vid.style.objectFit || 'contain';
    } catch (e) { }

    // attach stream
    try {
      vid.srcObject = currentStream;
    } catch (e) {
      console.warn('Could not set srcObject directly:', e);
      try {
        // fallback: create object URL (shouldn't be necessary for MediaStream but safe)
        // @ts-ignore
        vid.src = URL.createObjectURL(currentStream);
      } catch { }
    }

    const setErr = (msg) => {
      try { setVideoError(msg); } catch { }
    };

    const onCanPlay = () => {
      if (cleanedUp || myToken !== playTokenRef.current) return;
      attemptPlay().catch(() => { });
    };
    const onPlaying = () => {
      if (myToken !== playTokenRef.current) return;
      setCameraReady(true);
      setVideoError(null);
    };
    const onError = (ev) => {
      console.error('Video element error:', ev);
      const msg = (ev?.target?.error?.message) || 'Unknown video error';
      setErr('Video element error: ' + msg);
    };

    vid.addEventListener('loadedmetadata', onCanPlay);
    vid.addEventListener('canplay', onCanPlay);
    vid.addEventListener('playing', onPlaying);
    vid.addEventListener('error', onError);

    let safetyTimeout = setTimeout(() => {
      if (myToken === playTokenRef.current) attemptPlay().catch(() => { });
    }, 1200);

    async function attemptPlay(retries = 2) {
      if (cleanedUp || myToken !== playTokenRef.current) return;
      try {
        const p = vid.play();
        if (p) await p;
        if (myToken === playTokenRef.current) {
          setCameraReady(true);
          setVideoError(null);
        }
      } catch (err) {
        const name = err?.name || err?.message || String(err);
        console.warn('video.play() failed:', name);
        if (err && err.name === 'AbortError') {
          // race: wait a bit and retry if still current
          if (myToken === playTokenRef.current && retries > 0) {
            await new Promise(r => setTimeout(r, 60));
            return attemptPlay(retries - 1);
          }
          return;
        }
        if (err && err.name === 'NotAllowedError') {
          // requires user gesture -> show button
          createPlayButton();
          setErr('Playback requires user interaction. Click the button to enable camera.');
          return;
        }
        setErr('Could not play video: ' + (err?.message || String(err)));
      }
    }

    function createPlayButton() {
      if (!vid.parentElement) return;
      const container = vid.parentElement;
      const existing = container.querySelector('[data-video-play-button]');
      if (existing) return;

      const btn = document.createElement('button');
      btn.setAttribute('data-video-play-button', '1');
      btn.textContent = 'Enable camera';
      Object.assign(btn.style, {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        zIndex: '9999',
        padding: '10px 16px',
        borderRadius: '6px',
        border: 'none',
        cursor: 'pointer',
        background: '#2563eb',
        color: 'white'
      });

      if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }

      container.appendChild(btn);

      const onClick = async () => {
        try {
          await vid.play();
          setCameraReady(true);
          setVideoError(null);
          if (btn.parentElement) btn.parentElement.removeChild(btn);
        } catch (e) {
          console.error('User initiated play failed:', e);
          setVideoError('Could not start camera after user interaction.');
        }
      };

      btn.addEventListener('click', onClick, { once: true });
    }

    // initial attempt if ready
    if (vid.readyState >= 1) {
      attemptPlay().catch(() => { });
    }

    return () => {
      cleanedUp = true;
      clearTimeout(safetyTimeout);
      try {
        vid.removeEventListener('loadedmetadata', onCanPlay);
        vid.removeEventListener('canplay', onCanPlay);
        vid.removeEventListener('playing', onPlaying);
        vid.removeEventListener('error', onError);
      } catch (e) { }
      // detach srcObject to avoid leaks
      try {
        if (vid.srcObject === currentStream) vid.srcObject = null;
      } catch (e) { }
    };
    // intentionally only depend on `stream` (videoRef is stable)
  }, [stream]);

  // get camera
  const getVideoStream = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      });

      if (!mediaStream || mediaStream.getVideoTracks().length === 0) {
        throw new Error('No video track available');
      }

      setStream(mediaStream);
      streamRef.current = mediaStream;
      setVideoError(null);
      return mediaStream;
    } catch (err) {
      console.error('Error accessing media devices:', err);
      const msg = err?.message || 'Failed to access camera';
      setVideoError('Failed to access camera: ' + msg);
      alert(`Failed to access camera and microphone: ${msg}. Please ensure permissions are granted and no other app is using the camera.`);
      throw err;
    }
  };
  const MAX_CLIENT_QUEUE_BYTES = 0.5 * 1024 * 1024; // 2 MB local buffer cap
  let clientQueueBytes = 0;
  let pausedByBackpressure = false;
  let resumeTimer = null;

  function arrayBufferToBase64(ab) {
    // fast-ish conversion
    let binary = '';
    const bytes = new Uint8Array(ab);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }


  const startStreamingToBackend = useCallback((mediaStream, socket) => {
    if (!mediaStream) throw new Error('No media stream supplied');
    if (!window.MediaRecorder) throw new Error('MediaRecorder is not supported');

    const options = {
      mimeType: 'video/webm;codecs=vp8,opus',
      videoBitsPerSecond: 200_000,  // Reduced from default
      audioBitsPerSecond: 32_000
    };

    let headerSent = false;
    let recorder;
    let isPaused = false;
    let pendingAcks = 0;
    const maxPendingAcks = 3; // Max in-flight chunks

    try {
      recorder = new MediaRecorder(mediaStream, options);

      recorder.ondataavailable = async (event) => {
        if (!event.data || event.data.size === 0) return;

        // If too many pending acks, pause recorder
        if (pendingAcks >= maxPendingAcks && !isPaused) {
          console.warn('Too many pending acks, pausing recorder');
          recorder.pause();
          isPaused = true;
        }

        // Convert to ArrayBuffer
        const ab = await event.data.arrayBuffer();

        // For better performance, send binary instead of base64
        // Socket.io supports binary data natively
        const payload = {
          roomId: streamDataRef.current.roomId,
          data: ab,  // Send as ArrayBuffer, not base64
          isHeader: !headerSent
        };

        if (!headerSent) {
          headerSent = true;
          // Send header without ack handling
          socket.emit('stream-data', payload);
          return;
        }

        // Limit local buffer
        if (pendingChunksRef.current.length >= maxPendingChunks) {
          console.warn('Local buffer full, dropping oldest chunk');
          pendingChunksRef.current.shift();
        }

        pendingChunksRef.current.push(payload);
        sendNextChunk();
      };

      function sendNextChunk() {
        if (pendingChunksRef.current.length === 0) {
          // No more pending chunks, maybe resume recorder
          if (isPaused && pendingAcks < maxPendingAcks) {
            console.log('Resuming recorder');
            recorder.resume();
            isPaused = false;
            setBackpressureStatus(prev => ({
              ...prev,
              isPaused: false,
              resumedAt: Date.now()
            }));
          }
          return;
        }

        if (pendingAcks >= maxPendingAcks) {
          // Too many in flight, wait
          return;
        }

        const chunk = pendingChunksRef.current.shift();
        pendingAcks++;

        socket.emit('stream-data', chunk, (ack) => {
          pendingAcks--;

          if (!ack) {
            // No ack received, assume we should continue
            sendNextChunk();
            return;
          }

          if (ack.shouldContinue === false) {
            // Server says pause
            console.warn('Server requested pause due to backpressure');
            if (!isPaused) {
              recorder.pause();
              isPaused = true;
              setBackpressureStatus({
                isPaused: true,
                pausedAt: Date.now(),
                resumedAt: null
              });
            }

            // Try to resume after a delay
            setTimeout(() => {
              socket.emit('can-resume', { roomId: streamDataRef.current.roomId }, (resp) => {
                if (resp && resp.shouldResume) {
                  console.log('Server says we can resume');
                  if (isPaused && recorder.state === 'paused') {
                    recorder.resume();
                    isPaused = false;
                    setBackpressureStatus(prev => ({
                      ...prev,
                      isPaused: false,
                      resumedAt: Date.now()
                    }));
                  }
                  sendNextChunk();
                } else {
                  // Try again later
                  setTimeout(() => sendNextChunk(), 1000);
                }
              });
            }, 500);
          } else {
            // Continue sending
            sendNextChunk();
          }
        });
      }

      recorder.onerror = (err) => {
        console.error('MediaRecorder error', err);
        setVideoError('Video recording error: ' + (err?.message || String(err)));
      };

      recorder.onstop = () => {
        console.log('MediaRecorder stopped');
        setIsStreamingToBackend(false);
        pendingChunksRef.current = [];
        pendingAcks = 0;
      };

      // Start with larger timeslice to reduce chunk rate
      recorder.start(1000); // 1 second chunks
      mediaRecorderRef.current = recorder;
      setIsStreamingToBackend(true);

      return recorder;
    } catch (err) {
      console.error('Failed to create/start MediaRecorder:', err);
      setVideoError('Failed to start video streaming: ' + (err?.message || String(err)));
      throw err;
    }
  }, []);


  const stopStreamingToBackend = useCallback(() => {
    try {
      const r = mediaRecorderRef.current;
      if (r && r.state !== 'inactive') {
        r.stop();
      }
      mediaRecorderRef.current = null;
      setIsStreamingToBackend(false);
    } catch (e) {
      console.warn('Error stopping MediaRecorder:', e);
    }
  }, []);

  // Create peer (for viewers)
  const createPeer = (viewerId, hostIdLocal, mediaStream) => {
    const peer = new Peer({
      initiator: true,
      trickle: false,
      stream: mediaStream,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
      }
    });

    peer.on('signal', (signal) => {
      if (socketRef.current && streamDataRef.current && streamDataRef.current.roomId) {
        socketRef.current.emit('signal', {
          userId: hostIdLocal,
          roomId: streamDataRef.current.roomId,
          targetUserId: viewerId,
          signal
        });
      } else {
        console.error('Cannot emit signal: missing socket or streamData');
      }
    });

    return peer;
  };

  // startStream: create stream record, then connect socket and start media recorder & peer handling
  const startStream = async () => {
    if (!title.trim()) {
      alert('Please enter a stream title');
      return;
    }

    setVideoError(null);
    showLoadingState('Starting stream...');

    try {
      // ensure we have a camera stream
      const mediaStream = streamRef.current || await getVideoStream();
      if (!mediaStream) throw new Error('No media stream available');

      // create stream record on server (so we have roomId, _id)
      let created;
      try {
        created = await createStream(title, hostId);
        setStreamData(created);
        streamDataRef.current = created;
      } catch (apiErr) {
        console.warn('createStream failed, attempting fallback via direct API POST', apiErr);
        // fallback: try direct HTTP call if createStream helper fails
        const resp = await axios.post(`${NEXT_PUBLIC_API_URL}/streams`, { title, hostId });
        created = resp.data;
        setStreamData(created);
        streamDataRef.current = created;
      }

      // connect socket
      socketRef.current = io(NEXT_PUBLIC_API_BASE_URL, { transports: ['websocket'] });
      socketRef.current.on('connect', () => {
        socketRef.current.emit('register-user', { userId: hostId });
      });

      // start sending to backend (MediaRecorder -> socket)
      try {
        startStreamingToBackend(mediaStream, socketRef.current);
      } catch (e) {
        console.error('startStreamingToBackend error:', e);
      }

      // socket events
      socketRef.current.on('request-media-header', ({ roomId: reqRoom }) => {
        if (!streamDataRef.current || reqRoom !== streamDataRef.current.roomId) return;
        try {
          stopStreamingToBackend();
          setTimeout(() => {
            if (streamRef.current) startStreamingToBackend(streamRef.current, socketRef.current);
          }, 150);
        } catch (e) {
          console.error('Failed to restart recorder on header request:', e);
        }
      });

      socketRef.current.on('user-connected', (userId) => {
        console.log('New viewer connected:', userId);
        setViewerCount(v => v + 1);

        if (streamRef.current && streamDataRef.current) {
          const peer = createPeer(userId, hostId, streamRef.current);
          peersRef.current.push({ peerId: userId, peer });
          setPeers(prev => [...prev, { peerId: userId, peer }]);
        } else {
          console.error('Missing stream or streamData while creating peer');
        }
      });

      socketRef.current.on('user-signal', ({ userId, signal }) => {
        const item = peersRef.current.find(p => p.peerId === userId);
        if (item) {
          item.peer.signal(signal);
        }
      });

      socketRef.current.on('user-disconnected', (userId) => {
        console.log('Viewer disconnected:', userId);
        setViewerCount(v => Math.max(0, v - 1));
        const peerObj = peersRef.current.find(p => p.peerId === userId);
        if (peerObj) peerObj.peer.destroy();
        peersRef.current = peersRef.current.filter(p => p.peerId !== userId);
        setPeers(prev => prev.filter(p => p.peerId !== userId));
      });

      // mark streaming state
      setIsStreaming(true);
      hideLoadingState();
    } catch (err) {
      console.error('Error starting stream:', err);
      hideLoadingState();
      setVideoError('Error starting stream: ' + (err?.message || String(err)));
      alert('Failed to start stream: ' + (err?.message || String(err)));
    }
  };

  // stop stream
  const stopStream = async () => {
    try {
      hideLoadingState();
      stopStreamingToBackend();

      if (streamDataRef.current && streamDataRef.current._id) {
        await markStream(streamDataRef);
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }

      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }

      peersRef.current.forEach(({ peer }) => peer.destroy());
      peersRef.current = [];

      setIsStreaming(false);
      setStream(null);
      streamRef.current = null;
      setStreamData(null);
      streamDataRef.current = null;
      setPeers([]);
      setViewerCount(0);
      setCameraReady(false);
      setVideoError(null);
    } catch (error) {
      console.error('Error stopping stream:', error);
      alert('Failed to end stream properly. Please try again.');
    }
  };

  // JSX
  return (
    <div className="container mx-auto px-4">
      <h1 className="text-2xl font-bold mb-6">{isStreaming ? 'Live Stream' : 'Stream Studio'}</h1>

      {!isStreaming ? (
        <div className="bg-gray-800 rounded-lg p-6">
          <div className="mb-4">
            <label htmlFor="title" className="block text-sm font-medium mb-2">
              Stream Title
            </label>
            <input
              type="text"
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 rounded bg-gray-700 text-white"
              placeholder="Enter a title for your stream"
            />
          </div>

          <div className="bg-black rounded-lg overflow-hidden aspect-video mb-4 relative">
            <video
              ref={videoRef}
              id="cameraPreview"
              autoPlay={false}
              playsInline
              muted
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                backgroundColor: 'black',
                display: 'block'
              }}
            />

            {!cameraReady && !videoError && (
              <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-70">
                <div className="text-center">
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-white mb-2"></div>
                  <p>Initializing camera...</p>
                </div>
              </div>
            )}

            {videoError && (
              <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-90">
                <div className="text-center p-4">
                  <div className="text-red-500 text-4xl mb-2">⚠️</div>
                  <p className="mb-4">{videoError}</p>
                  <button
                    onClick={() => getVideoStream().catch(console.error)}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
                  >
                    Retry Camera Access
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="mt-4 flex justify-between">
            <div>
              {cameraReady && (
                <span className="text-green-400 text-sm flex items-center">
                  <span className="w-2 h-2 bg-green-400 rounded-full mr-2"></span>
                  Camera ready
                </span>
              )}
            </div>

            <button
              onClick={() => startStream()}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg"
              disabled={!cameraReady || !title.trim()}
            >
              Start Streaming
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 space-y-4">
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold">{title}</h2>
                <div className="flex items-center">
                  <span className="bg-red-600 px-3 py-1 rounded-full text-sm mr-4">LIVE</span>
                  <span className="text-gray-300">{viewerCount} viewer{viewerCount !== 1 ? 's' : ''}</span>
                </div>
              </div>

              <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
                <video
                  ref={videoRef}
                  autoPlay={false}
                  muted
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    backgroundColor: 'black',
                    display: 'block'
                  }}
                />

                {!cameraReady && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-70">
                    <div className="text-center">
                      <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-white mb-2"></div>
                      <p>Initializing camera...</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4">
                <RtmpControls
                  socket={socketRef.current}
                  roomId={streamData?.roomId}
                  userId={hostId}
                  isHost={true}
                  startStream={startStream}
                />
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  onClick={stopStream}
                  className="bg-gray-700 hover:bg-gray-600 text-white px-6 py-2 rounded-lg"
                >
                  End Stream
                </button>
              </div>
            </div>
          </div>

          <div className="bg-gray-800 rounded-lg p-4">
            <ChatPanel
              socket={socketRef.current}
              roomId={streamData?.roomId}
              userId={hostId}
              username={`Host: ${title.split(' ')[0]}`}
              isHost={true}
            />
          </div>
        </div>
      )}
      {backpressureStatus.isPaused && (
        <div className="bg-yellow-600/20 border border-yellow-600 rounded p-2 mt-2">
          <p className="text-yellow-200 text-sm">
            ⚠️ Stream paused due to server backpressure. Waiting to resume...
          </p>
        </div>
      )}
    </div>
  );
};

export default StreamStudio;
