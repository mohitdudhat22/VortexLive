import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import { v4 as uuidv4 } from 'uuid';

const ViewStream = () => {
  const [hostStream, setHostStream] = useState(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const [hostId, setHostId] = useState(null);
  
  const { roomId } = useParams();
  const navigate = useNavigate();
  
  const socketRef = useRef();
  const peerRef = useRef();
  const videoRef = useRef();
  
  const viewerId = localStorage.getItem('userId') || uuidv4();
  
  // Save the user ID to localStorage if it doesn't exist
  useEffect(() => {
    if (!localStorage.getItem('userId')) {
      localStorage.setItem('userId', viewerId);
    }
  }, [viewerId]);

  useEffect(() => {
    let connectionTimeout;
    
    try {
      // Connect to socket server
      socketRef.current = io(import.meta.env.VITE_API_URL);
      
      // Register user ID with socket
      socketRef.current.emit('register-user', { userId: viewerId });
      
      // Join the room as a viewer
      socketRef.current.emit('join-room', roomId, viewerId);
      
      // Request host ID from server
      socketRef.current.emit('get-host-id', { roomId });
      
      // Listen for host ID response
      socketRef.current.on('host-id', (id) => {
        console.log('Received host ID:', id);
        setHostId(id);
      });
      
      // Create peer instance - NOT an initiator
      const peer = new Peer({
        initiator: false,
        trickle: false,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });
      
      peerRef.current = peer;
      
      // Handle receiving a signal from the host
      socketRef.current.on('user-signal', ({ userId, signal }) => {
        console.log('Received signal from host', userId);
        
        // Store the host ID when we receive a signal from them
        if (!hostId) {
          setHostId(userId);
        }
        
        // Make sure we only process each signal once
        if (peerRef.current && !peerRef.current.destroyed) {
          try {
            peerRef.current.signal(signal);
          } catch (err) {
            console.error('Error processing signal:', err);
          }
        }
      });
      
      peer.on('signal', signal => {
        console.log('Generated signal for host');
        socketRef.current.emit('signal', { 
          userId: viewerId, 
          roomId, 
          targetUserId: hostId,
          signal 
        });
      });
      
      peer.on('stream', stream => {
        console.log('Received stream from host');
        console.log("Video tracks:", stream.getVideoTracks().length);
        console.log("Audio tracks:", stream.getAudioTracks().length);
        
        setHostStream(stream);
        
        // More robust video element handling
        if (videoRef.current) {
          console.log("Setting viewer video source...");
          videoRef.current.srcObject = null;  // Clear any existing source
          videoRef.current.srcObject = stream;
          
          // Force play with a delay to ensure DOM update
          setTimeout(() => {
            if (videoRef.current) {
              const playPromise = videoRef.current.play();
              if (playPromise !== undefined) {
                playPromise
                  .then(() => console.log("Viewer video playback started successfully"))
                  .catch(e => {
                    console.error("Error playing viewer video:", e);
                    // Try to play without audio if autoplay was blocked
                    if (e.name === "NotAllowedError") {
                      videoRef.current.muted = true;
                      videoRef.current.play().catch(e2 => 
                        console.error("Still can't play even muted:", e2)
                      );
                    }
                  });
              }
            }
          }, 100);
        } else {
          console.error("Viewer video ref is not available");
        }
        
        setConnected(true);
      });
      
      peer.on('error', err => {
        console.error('Peer connection error:', err);
        setConnectionError(true);
      });
      
      // Set a timeout for connection
      connectionTimeout = setTimeout(() => {
        if (!connected) {
          console.log('Connection timeout');
          setConnectionError(true);
        }
      }, 15000); // 15 seconds timeout
    } catch (err) {
      console.error('Error initializing peer connection:', err);
      setConnectionError(true);
    }
    
    return () => {
      // Clean up on unmount
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
      }
      
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
      
      if (peerRef.current) {
        peerRef.current.destroy();
      }
    };
  }, [roomId, viewerId, hostId]);

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Viewing Stream</h1>
      
      {connectionError ? (
        <div className="bg-gray-800 rounded-lg p-8 text-center">
          <h3 className="text-xl mb-4">Could not connect to the stream</h3>
          <p className="text-gray-400 mb-6">The stream may have ended or the host is not available.</p>
          <button
            onClick={() => navigate('/')}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg"
          >
            Back to Home
          </button>
        </div>
      ) : (
        <div className="bg-gray-800 rounded-lg overflow-hidden">
          <div className="relative aspect-video bg-black">
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline
              muted  // Start muted to avoid autoplay restrictions
              style={{ width: '100%', height: '100%' }}  // Direct style
              className="bg-black"  // Ensure background is black
            />
            {!connected && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-white mb-2"></div>
                  <p>Connecting to stream...</p>
                </div>
              </div>
            )}
            <div className="absolute bottom-4 right-4 flex space-x-2">
              <button 
                onClick={() => {
                  if (videoRef.current) {
                    videoRef.current.muted = !videoRef.current.muted;
                  }
                }}
                className="bg-gray-800 bg-opacity-70 p-2 rounded-full"
              >
                {videoRef.current?.muted ? "🔇" : "��"}
              </button>
            </div>
          </div>
          
          <div className="p-4">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-xl font-semibold">Live Stream</h2>
                <p className="text-gray-400">Room: {roomId}</p>
              </div>
              <button
                onClick={() => navigate('/')}
                className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded"
              >
                Exit Stream
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ViewStream; 