import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import { v4 as uuidv4 } from 'uuid';

const ViewStream = () => {
  const [hostStream, setHostStream] = useState(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  
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
    // Connect to socket server
    socketRef.current = io('http://localhost:5000');
    
    // Join the room as a viewer
    socketRef.current.emit('join-room', roomId, viewerId);
    
    // Handle receiving a signal from the host
    socketRef.current.on('user-signal', ({ userId, signal }) => {
      // Only process signals from the host
      if (peerRef.current && !peerRef.current.destroyed) {
        peerRef.current.signal(signal);
      }
    });
    
    // Set up the peer connection
    const peer = new Peer({
      initiator: false,
      trickle: false
    });
    
    peer.on('signal', signal => {
      socketRef.current.emit('signal', { userId: viewerId, roomId, signal });
    });
    
    peer.on('stream', stream => {
      setHostStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setConnected(true);
    });
    
    peer.on('error', err => {
      console.error('Peer connection error:', err);
      setConnectionError(true);
    });
    
    peerRef.current = peer;
    
    // Set a timeout for connection
    const connectionTimeout = setTimeout(() => {
      if (!connected) {
        setConnectionError(true);
      }
    }, 15000); // 15 seconds timeout
    
    return () => {
      // Clean up on unmount
      clearTimeout(connectionTimeout);
      
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
      
      if (peerRef.current) {
        peerRef.current.destroy();
      }
    };
  }, [roomId, viewerId]);

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
          {!connected ? (
            <div className="aspect-video flex items-center justify-center bg-black">
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-white mb-2"></div>
                <p>Connecting to stream...</p>
              </div>
            </div>
          ) : (
            <div className="relative aspect-video bg-black">
              <video 
                ref={videoRef} 
                autoPlay 
                className="w-full h-full object-contain"
              />
              <div className="absolute top-4 left-4">
                <span className="bg-red-600 px-3 py-1 rounded-full text-sm">LIVE</span>
              </div>
            </div>
          )}
          
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