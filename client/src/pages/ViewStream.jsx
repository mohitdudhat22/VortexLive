import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

const ViewStream = () => {
  const [hostStream, setHostStream] = useState(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [connectionError, setConnectionError] = useState(null);
  const [streamInfo, setStreamInfo] = useState(null);
  const [hostId, setHostId] = useState(null);
  
  const { roomId } = useParams();
  const navigate = useNavigate();
  
  const socketRef = useRef();
  const peerRef = useRef();
  const videoRef = useRef();
  const connectionAttemptedRef = useRef(false);
  
  // Generate or retrieve viewer ID
  const viewerId = localStorage.getItem('viewerId') || uuidv4();
  
  // Save the user ID to localStorage if it doesn't exist
  useEffect(() => {
    if (!localStorage.getItem('viewerId')) {
      localStorage.setItem('viewerId', viewerId);
    }
  }, [viewerId]);

  // Fetch stream info from API
  useEffect(() => {
    const fetchStreamInfo = async () => {
      try {
        // Find the stream by roomId
        const response = await axios.get(`http://localhost:5000/api/streams?roomId=${roomId}`);
        if (response.data && response.data.length > 0) {
          setStreamInfo(response.data[0]);
          setHostId(response.data[0].hostId);
          console.log("Found stream info:", response.data[0]);
        } else {
          setConnectionError("Stream not found or no longer active");
          setConnecting(false);
        }
      } catch (error) {
        console.error("Error fetching stream info:", error);
        setConnectionError("Error connecting to stream");
        setConnecting(false);
      }
    };
    
    fetchStreamInfo();
  }, [roomId]);

  // Set up WebRTC connection
  useEffect(() => {
    // Only proceed if we have the host ID and haven't attempted connection
    if (!hostId || connectionAttemptedRef.current) return;
    
    // Mark that we've attempted connection to avoid loops
    connectionAttemptedRef.current = true;
    
    console.log("Setting up connection with host ID:", hostId);
    
    // Connection timeout - if not connected within 15 seconds, show error
    const connectionTimeout = setTimeout(() => {
      if (!connected) {
        console.log("Connection timeout");
        setConnectionError("Could not connect to stream. The host may be offline.");
        setConnecting(false);
      }
    }, 15000);

    try {
      // Connect to socket server with explicit URL
      console.log("Connecting to socket server...");
      socketRef.current = io('http://localhost:5000');
      
      // Register viewer ID with socket
      console.log("Registering viewer ID:", viewerId);
      socketRef.current.emit('register-user', { userId: viewerId });
      
      // Join the room as a viewer
      console.log("Joining room:", roomId);
      socketRef.current.emit('join-room', roomId, viewerId);
      
      // Create peer connection
      const peer = new Peer({
        initiator: false,
        trickle: false,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun.global.stunprotocol.org:3478' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });
      
      peerRef.current = peer;
      
      // Listen for signals from host
      console.log("Setting up signal listener");
      socketRef.current.on('user-signal', ({ userId, signal }) => {
        console.log('Received signal from user:', userId);
        if (userId === hostId && peerRef.current && !peerRef.current.destroyed) {
          console.log('Processing signal from host');
          try {
            peerRef.current.signal(signal);
          } catch (err) {
            console.error('Error processing signal:', err);
          }
        } else {
          console.log('Ignoring signal from non-host user or destroyed peer');
        }
      });
      
      // Send signals to host
      peer.on('signal', signal => {
        console.log('Generated signal for host, sending to:', hostId);
        if (socketRef.current) {
          socketRef.current.emit('signal', { 
            userId: viewerId, 
            roomId, 
            targetUserId: hostId, 
            signal 
          });
        }
      });
      
      // Handle incoming stream
      peer.on('stream', stream => {
        console.log('Received stream from host!');
        console.log('Video tracks:', stream.getVideoTracks().length);
        console.log('Audio tracks:', stream.getAudioTracks().length);
        
        setHostStream(stream);
        setConnected(true);
        setConnecting(false);
        clearTimeout(connectionTimeout);
        
        // Attach stream to video element
        if (videoRef.current) {
          console.log("Attaching stream to video element");
          videoRef.current.srcObject = stream;
          
          // Try to play the video
          const playPromise = videoRef.current.play();
          
          if (playPromise !== undefined) {
            playPromise.catch(error => {
              console.error('Error playing video:', error);
              
              // If autoplay was prevented, add a play button
              const playButton = document.createElement('button');
              playButton.textContent = 'Click to play stream';
              playButton.className = 'bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-10';
              
              if (videoRef.current && videoRef.current.parentNode) {
                videoRef.current.parentNode.appendChild(playButton);
                
                playButton.onclick = () => {
                  // Try to play with user interaction
                  videoRef.current.play()
                    .then(() => {
                      console.log('Video playback started after user interaction');
                      if (videoRef.current.parentNode.contains(playButton)) {
                        videoRef.current.parentNode.removeChild(playButton);
                      }
                    })
                    .catch(err => {
                      console.error('Still cannot play video:', err);
                    });
                };
              }
            });
          }
        } else {
          console.error("Video ref is not available");
        }
      });
      
      // Handle connection errors
      peer.on('error', err => {
        console.error('Peer connection error:', err);
        setConnectionError(`Connection error: ${err.message}`);
        setConnecting(false);
      });
      
      // Handle connection close
      peer.on('close', () => {
        console.log('Peer connection closed');
        setConnectionError('The stream has ended');
        setConnected(false);
        setConnecting(false);
      });
      
      // Listen for disconnection events
      socketRef.current.on('user-disconnected', userId => {
        if (userId === hostId) {
          console.log('Host disconnected');
          setConnectionError('The stream has ended');
          setConnected(false);
          setConnecting(false);
          
          if (peerRef.current && !peerRef.current.destroyed) {
            peerRef.current.destroy();
          }
        }
      });
      
      return () => {
        // Clean up on unmount
        clearTimeout(connectionTimeout);
        
        if (socketRef.current) {
          socketRef.current.disconnect();
        }
        
        if (peerRef.current && !peerRef.current.destroyed) {
          peerRef.current.destroy();
        }
      };
    } catch (err) {
      console.error('Error setting up connection:', err);
      setConnectionError(`Error setting up connection: ${err.message}`);
      setConnecting(false);
      clearTimeout(connectionTimeout);
    }
  }, [roomId, viewerId, hostId]); // Removed 'connected' from dependencies
  
  // Function to retry connection
  const retryConnection = () => {
    setConnecting(true);
    setConnectionError(null);
    connectionAttemptedRef.current = false;
    
    // Clean up any existing connections
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    
    if (peerRef.current && !peerRef.current.destroyed) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    
    // Re-fetch stream info, which will trigger the connection setup effect
    axios.get(`http://localhost:5000/api/streams?roomId=${roomId}`)
      .then(response => {
        if (response.data && response.data.length > 0) {
          setStreamInfo(response.data[0]);
          setHostId(response.data[0].hostId);
        } else {
          setConnectionError("Stream not found or no longer active");
          setConnecting(false);
        }
      })
      .catch(error => {
        console.error("Error re-fetching stream info:", error);
        setConnectionError("Error reconnecting to stream");
        setConnecting(false);
      });
  };

  return (
    <div className="max-w-4xl mx-auto p-4">
      <div className="mb-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold">{streamInfo?.title || 'Live Stream'}</h1>
        <button 
          onClick={() => navigate('/')}
          className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-1 rounded"
        >
          Back to Home
        </button>
      </div>
      
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <div className="relative aspect-video bg-black">
          {/* Main video element */}
          <video 
            ref={videoRef} 
            autoPlay 
            playsInline
            controls  
            style={{ width: '100%', height: '100%', backgroundColor: 'black' }} 
            className="object-contain"
          />
          
          {/* Connection status overlays */}
          {connecting && (
            <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-70">
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-white mb-2"></div>
                <p className="text-lg">Connecting to stream...</p>
              </div>
            </div>
          )}
          
          {connectionError && (
            <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-70">
              <div className="text-center max-w-md p-6">
                <div className="text-red-500 text-5xl mb-3">⚠️</div>
                <p className="text-xl mb-4">{connectionError}</p>
                <button 
                  onClick={retryConnection}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg"
                >
                  Try Again
                </button>
              </div>
            </div>
          )}
        </div>
        
        {connected && (
          <div className="p-4">
            <div className="flex items-center mb-2">
              <span className="bg-red-600 px-2 py-1 rounded-full text-sm mr-2">LIVE</span>
              <p className="text-gray-300">Room: {roomId}</p>
            </div>
            <h2 className="text-xl font-semibold mb-2">{streamInfo?.title}</h2>
          </div>
        )}
      </div>
      
      {/* Debug info - useful for troubleshooting */}
      <div className="mt-4 p-4 bg-gray-900 rounded text-xs">
        <p>Debug Info:</p>
        <p>Room ID: {roomId}</p>
        <p>Host ID: {hostId || 'Unknown'}</p>
        <p>Connected: {connected ? 'Yes' : 'No'}</p>
        <p>Connection Attempted: {connectionAttemptedRef.current ? 'Yes' : 'No'}</p>
        <p>Host Stream: {hostStream ? 'Received' : 'Not received'}</p>
        <p>Video Tracks: {hostStream ? hostStream.getVideoTracks().length : 0}</p>
        <p>Audio Tracks: {hostStream ? hostStream.getAudioTracks().length : 0}</p>
        {connectionError && <p className="text-red-400">Error: {connectionError}</p>}
      </div>
    </div>
  );
};

export default ViewStream; 