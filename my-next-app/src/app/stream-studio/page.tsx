// @ts-nocheck
'use client'
import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import ChatPanel from '../../components/ChatPanel';
import RtmpControls from '../../components/RtmpControls';
import { NEXT_PUBLIC_API_URL } from '@/src/utils/constants';
import { createStream } from './../../api/stream';

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
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [isStreamingToBackend, setIsStreamingToBackend] = useState(false);
  const mediaRecorderRef = useRef(null);


  const videoRef = useRef();
  const socketRef = useRef();
  const peersRef = useRef([]);

  // Create refs to keep track of latest state values
  const streamRef = useRef(null);
  const streamDataRef = useRef(null);


  useEffect(() => {
    let storedId = localStorage.getItem('userId');
    if (!storedId) {
      storedId = uuidv4();
      localStorage.setItem('userId', storedId);
    }
    setHostId(storedId);
  }, []);

  function getMediaRecorderOptions({
    videoBitsPerSecond = 2_500_000,
    audioBitsPerSecond = 128_000,
    codecs = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
  } = {}) {
    // Pick the first supported MIME type
    const mimeType =
      codecs.find(type => MediaRecorder.isTypeSupported(type)) ||
      codecs.at(-1);

    console.log(`[MediaRecorder] Using codec: ${mimeType}`);

    return {
      mimeType,
      videoBitsPerSecond,
      audioBitsPerSecond
    };
  }

  // Update refs when state changes
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  useEffect(() => {
    streamDataRef.current = streamData;
  }, [streamData]);

  // Save the user ID to localStorage if it doesn't exist
  useEffect(() => {
    if (!localStorage.getItem('userId')) {
      localStorage.setItem('userId', hostId);
    }
  }, [hostId]);

  // Get camera on component mount
  useEffect(() => {
    if (!isStreaming && !stream) {
      getVideoStream().catch(err => {
        console.error("Initial camera setup failed:", err);
        setVideoError("Could not access camera: " + err.message);
      });
    }
  }, []);

  // This effect handles attaching the stream to the video element when both are available
  useEffect(() => {
    if (stream && videoRef.current) {
      try {
        // Method 1: Direct srcObject assignment
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;

        videoRef.current.onplaying = () => {
          setCameraReady(true);
        };

        videoRef.current.onerror = (e) => {
          console.error("Video element error:", e);
          setVideoError("Video element error: " + e.target.error?.message || "Unknown error");
        };

        // Force a play attempt
        const playPromise = videoRef.current.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              setCameraReady(true);
            })
            .catch(e => {
              console.error("Error playing video from useEffect:", e);

              // Try Method 2: Create a fallback video element if the first one fails
              console.log("Trying fallback method...");
              const fallbackVideo = document.createElement('video');
              fallbackVideo.autoplay = true;
              fallbackVideo.playsInline = true;
              fallbackVideo.muted = true;
              fallbackVideo.width = videoRef.current.clientWidth;
              fallbackVideo.height = videoRef.current.clientHeight;
              fallbackVideo.style.width = '100%';
              fallbackVideo.style.height = '100%';
              fallbackVideo.style.objectFit = 'contain';
              fallbackVideo.style.backgroundColor = 'black';
              fallbackVideo.srcObject = stream;

              // Try to play the fallback
              fallbackVideo.play()
                .then(() => {
                  console.log("Fallback video playing!");

                  // Replace the original video
                  if (videoRef.current && videoRef.current.parentNode) {
                    videoRef.current.parentNode.replaceChild(fallbackVideo, videoRef.current);
                    videoRef.current = fallbackVideo; // Update the ref
                    setCameraReady(true);
                  }
                })
                .catch(fallbackErr => {
                  console.error("Fallback also failed:", fallbackErr);

                  // Final option: Create a button for user interaction
                  const playButton = document.createElement('button');
                  playButton.textContent = 'Click to enable camera';
                  playButton.style.position = 'absolute';
                  playButton.style.top = '50%';
                  playButton.style.left = '50%';
                  playButton.style.transform = 'translate(-50%, -50%)';
                  playButton.style.zIndex = '1000';
                  playButton.style.padding = '10px 20px';
                  playButton.style.backgroundColor = '#3b82f6';
                  playButton.style.color = 'white';
                  playButton.style.border = 'none';
                  playButton.style.borderRadius = '5px';
                  playButton.style.cursor = 'pointer';

                  const videoContainer = videoRef.current.parentElement;
                  if (videoContainer) {
                    videoContainer.style.position = 'relative';
                    videoContainer.appendChild(playButton);

                    playButton.onclick = () => {
                      videoRef.current.play()
                        .then(() => {
                          console.log("Video playback started after user interaction");
                          videoContainer.removeChild(playButton);
                          setCameraReady(true);
                        })
                        .catch(err => {
                          console.error("Still can't play video after user interaction:", err);
                          setVideoError("Could not access camera. Please check your permissions and try again.");
                        });
                    };
                  }
                });
            });
        }
      } catch (err) {
        console.error("Error attaching stream to video:", err);
        setVideoError("Error displaying camera: " + err.message);
      }
    }
  }, [stream, videoRef.current]);

  const getVideoStream = async () => {
    try {

      // Try a simpler constraint first just to get something working
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: true
      });

      const videoTrack = mediaStream.getVideoTracks()[0];

      if (mediaStream.getVideoTracks().length === 0) {
        throw new Error("No video track available in the media stream");
      }

      setStream(mediaStream);
      streamRef.current = mediaStream;
      setVideoError(null);

      return mediaStream;
    } catch (err) {
      console.error("Error accessing media devices:", err);
      setVideoError("Failed to access camera: " + err.message);
      alert(`Failed to access camera and microphone: ${err.message}. Please ensure you've granted camera permission and no other app is using the camera.`);
      throw err;
    }
  };
  const startStreamingToBackend = useCallback((mediaStream, socket) => {
    try {
      if (!window.MediaRecorder) {
        throw new Error('MediaRecorder is not supported in this browser');
      }

      const options = getMediaRecorderOptions();
      const recorder = new MediaRecorder(mediaStream, options);
      console.log('Using MediaRecorder with:', options.mimeType);

      let headerSent = false;
      recorder.ondataavailable = async (event) => {

      const ab = await event.data.arrayBuffer();

      if (!headerSent) {
        socket.emit('stream-data', { roomId: streamDataRef.current.roomId, data: ab, isHeader: true });
        headerSent = true;
        return;
      }
        try {
          if (event.data && event.data.size > 0) {
            const arrayBuffer = await event.data.arrayBuffer();
            if (socket && socket.connected && streamDataRef.current) {
              socket.emit('stream-data', {
                roomId: streamDataRef.current.roomId,
                data: arrayBuffer
              });
            }
          }
        } catch (e) {
          console.error('ondataavailable error:', e);
        }
      };

      recorder.onerror = (error) => {
        console.error('MediaRecorder error:', error);
        toast.error('Video recording error: ' + error.message);
      };

      recorder.onstop = () => {
        setIsStreamingToBackend(false);
      };

      // Start recording with 300ms timeslices for smoother chunking
      recorder.start(1000);

      mediaRecorderRef.current = recorder;
      setMediaRecorder(recorder);
      setIsStreamingToBackend(true);

      console.log('MediaRecorder started successfully');
      return recorder;

    } catch (error) {
      console.error('Error starting MediaRecorder:', error);
      toast.error('Failed to start video streaming: ' + error.message);
      throw error;
    }
  }, []);

  // Add this function to stop streaming to backend
  const stopStreamingToBackend = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      console.log('Stopping MediaRecorder...');
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
      setMediaRecorder(null);
      setIsStreamingToBackend(false);
    }
  }, []);

  const startStream = async () => {
    console.log("-------------------- start Stream ------------------------------")
    if (!title.trim()) {
      alert("Please enter a stream title");
      return;
    }

    try {
      // Show loading state
      const loadingElem = document.createElement('div');
      loadingElem.id = 'stream-loading';
      loadingElem.style.position = 'fixed';
      loadingElem.style.top = '0';
      loadingElem.style.left = '0';
      loadingElem.style.right = '0';
      loadingElem.style.bottom = '0';
      loadingElem.style.backgroundColor = 'rgba(0,0,0,0.7)';
      loadingElem.style.display = 'flex';
      loadingElem.style.alignItems = 'center';
      loadingElem.style.justifyContent = 'center';
      loadingElem.style.zIndex = '9999';
      loadingElem.innerHTML = '<div style="color:white;text-align:center;"><div style="display:inline-block;width:40px;height:40px;border:3px solid #fff;border-radius:50%;border-top-color:transparent;animation:spin 1s linear infinite;"></div><div style="margin-top:10px;">Starting stream...</div></div>';
      document.body.appendChild(loadingElem);

      // Define the animation
      const style = document.createElement('style');
      style.innerHTML = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
      document.head.appendChild(style);

      // Get the stream
      const mediaStream = await getVideoStream();
      
      const loadingElement = document.getElementById('stream-loading');
      if (loadingElement) {
        document.body.removeChild(loadingElement);
      }

      // Connect to socket server - after UI has changed
      setTimeout(() => {
        socketRef.current = io(NEXT_PUBLIC_API_URL);
        socketRef.current.emit('register-user', { userId: hostId });

        // This will make the video available for FFmpeg to consume
        try {
          startStreamingToBackend(mediaStream, socketRef.current);
          console.log('Started streaming video data to backend');
        } catch (error) {
          console.error('Failed to start backend streaming:', error);
          toast.error('Warning: External streaming may not work');
        }

        // Listen for server request to resend fresh WebM header (restart MediaRecorder)
        socketRef.current.on('request-media-header', ({ roomId: reqRoom }) => {
          if (!streamDataRef.current || reqRoom !== streamDataRef.current.roomId) return;
          console.log('[StreamStudio] Received request-media-header, restarting MediaRecorder...');
          try {
            stopStreamingToBackend();
            // Small delay to ensure recorder stops
            setTimeout(() => {
              if (streamRef.current) {
                startStreamingToBackend(streamRef.current, socketRef.current);
                console.log('[StreamStudio] MediaRecorder restarted to resend header');
              }
            }, 150);
          } catch (e) {
            console.error('Failed to restart MediaRecorder on header request:', e);
          }
        });

        // Handle new viewer connections
        socketRef.current.on('user-connected', (userId) => {
          console.log('New viewer connected:', userId);
          setViewerCount(prev => prev + 1);

          // Use the refs to access the latest values
          if (streamRef.current && streamDataRef.current) {
            const peer = createPeer(userId, hostId, streamRef.current);
            peersRef.current.push({
              peerId: userId,
              peer,
            });

            setPeers(prevPeers => [...prevPeers, { peerId: userId, peer }]);
          } else {
            console.error('Cannot create peer: stream or streamData is not available');
            console.log('Stream available:', !!streamRef.current);
            console.log('StreamData available:', !!streamDataRef.current);
          }
        });

        // Handle signals from viewers
        socketRef.current.on('user-signal', ({ userId, signal }) => {
          const item = peersRef.current.find(p => p.peerId === userId);
          if (item) {
            item.peer.signal(signal);
          }
        });

        // Handle viewer disconnections
        socketRef.current.on('user-disconnected', (userId) => {
          console.log('Viewer disconnected:', userId);
          setViewerCount(prev => Math.max(0, prev - 1));

          const peerObj = peersRef.current.find(p => p.peerId === userId);
          if (peerObj) {
            peerObj.peer.destroy();
          }

          peersRef.current = peersRef.current.filter(p => p.peerId !== userId);
          setPeers(prevPeers => prevPeers.filter(p => p.peerId !== userId));
        });
      }, 500);
    } catch (error) {
      // Remove loading overlay on error too
      const loadingElement = document.getElementById('stream-loading');
      if (loadingElement) {
        document.body.removeChild(loadingElement);
      }

      console.error('Error starting stream:', error);
    }
  };

  // The rest of your code remains the same
  const createPeer = (viewerId, hostId, stream) => {
    const peer = new Peer({
      initiator: true,
      trickle: false,
      stream,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
      }
    });

    peer.on('signal', signal => {
      if (socketRef.current && streamDataRef.current && streamDataRef.current.roomId) {
        console.log('Host sending signal to viewer', viewerId);
        socketRef.current.emit('signal', {
          userId: hostId,
          roomId: streamDataRef.current.roomId,
          targetUserId: viewerId,
          signal
        });
      } else {
        console.error('Cannot emit signal: streamData or socketRef is not available');
        console.log('SocketRef available:', !!socketRef.current);
        console.log('StreamData available:', !!streamDataRef.current);
        if (streamDataRef.current) {
          console.log('RoomId available:', !!streamDataRef.current.roomId);
        }
      }
    });

    return peer;
  };

  const stopStream = async () => {
    try {
      // *** NEW: Stop streaming video data to backend ***
      stopStreamingToBackend();

      if (streamDataRef.current && streamDataRef.current._id) {
        await axios.patch(`${NEXT_PUBLIC_API_URL}/api/streams/${streamDataRef.current._id}/end`);
      }

      // Stop all tracks in the stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }

      // Clean up socket and peers
      if (socketRef.current) {
        socketRef.current.disconnect();
      }

      peersRef.current.forEach(({ peer }) => {
        peer.destroy();
      });

      setIsStreaming(false);
      setStream(null);
      streamRef.current = null;
      setStreamData(null);
      streamDataRef.current = null;
      setPeers([]);
      setViewerCount(0);
      setCameraReady(false);

      // Navigate to home if you have router
      // router.push('/');

    } catch (error) {
      console.error('Error stopping stream:', error);
      alert('Failed to end stream properly. Please try again.');
    }
  };

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
              autoPlay
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
              onClick={() => setIsStreaming(true)}
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
                  autoPlay
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
                  setStreamData = {setStreamData}
                  streamDataRef = {streamDataRef}
                  userId={hostId}
                  title={title}
                  isHost={true}
                  startStream = {startStream}
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

          <div className="bg-gray-800 rounded-lg">
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
    </div>
  );
};

export default StreamStudio;