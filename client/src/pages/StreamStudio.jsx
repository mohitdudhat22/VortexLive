import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import io from 'socket.io-client';
import Peer from 'simple-peer';

const StreamStudio = () => {
  const [title, setTitle] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [stream, setStream] = useState(null);
  const [streamData, setStreamData] = useState(null);
  const [peers, setPeers] = useState([]);
  const [viewerCount, setViewerCount] = useState(0);
  
  const videoRef = useRef();
  const socketRef = useRef();
  const peersRef = useRef([]);
  const navigate = useNavigate();
  
  const hostId = localStorage.getItem('userId') || uuidv4();
  
  // Save the user ID to localStorage if it doesn't exist
  useEffect(() => {
    if (!localStorage.getItem('userId')) {
      localStorage.setItem('userId', hostId);
    }
  }, [hostId]);

  const getVideoStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        },
        audio: true
      });
      
      setStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error("Error accessing media devices:", err);
      alert("Failed to access camera and microphone. Please make sure they are available and you've granted permission.");
    }
  };

  const startStream = async () => {
    if (!title.trim()) {
      alert("Please enter a stream title");
      return;
    }
    
    try {
      await getVideoStream();
      
      // Create a stream in the database
      const response = await axios.post('http://localhost:5000/api/streams', {
        title,
        hostId
      });
      
      setStreamData(response.data);
      setIsStreaming(true);
      
      // Connect to socket server
      socketRef.current = io('http://localhost:5000');
      
      // Join the room
      socketRef.current.emit('join-room', response.data.roomId, hostId);
      
      // Handle new viewer connections
      socketRef.current.on('user-connected', (userId) => {
        console.log('New viewer connected:', userId);
        setViewerCount(prev => prev + 1);
        
        // Create a new peer for the viewer
        const peer = createPeer(userId, hostId, stream);
        peersRef.current.push({
          peerId: userId,
          peer,
        });
        
        setPeers(prevPeers => [...prevPeers, { peerId: userId, peer }]);
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
      
    } catch (error) {
      console.error('Error starting stream:', error);
      alert('Failed to start stream. Please try again.');
    }
  };

  const createPeer = (viewerId, hostId, stream) => {
    const peer = new Peer({
      initiator: true,
      trickle: false,
      stream,
    });

    peer.on('signal', signal => {
      socketRef.current.emit('signal', { userId: hostId, roomId: streamData.roomId, signal });
    });

    return peer;
  };

  const stopStream = async () => {
    try {
      if (streamData && streamData._id) {
        await axios.patch(`http://localhost:5000/api/streams/${streamData._id}/end`);
      }
      
      // Stop all tracks in the stream
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
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
      setStreamData(null);
      setPeers([]);
      setViewerCount(0);
      navigate('/');
      
    } catch (error) {
      console.error('Error stopping stream:', error);
      alert('Failed to end stream properly. Please try again.');
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">Streaming Studio</h1>
      
      {!isStreaming ? (
        <div className="bg-gray-800 rounded-lg p-6 mb-8">
          <h2 className="text-xl font-semibold mb-4">Start a New Stream</h2>
          <div className="mb-4">
            <label className="block text-gray-300 mb-2">Stream Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-gray-700 rounded px-4 py-2 text-white"
              placeholder="Enter your stream title"
            />
          </div>
          <button
            onClick={startStream}
            className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-lg"
          >
            Go Live
          </button>
        </div>
      ) : (
        <div>
          <div className="bg-gray-800 rounded-lg p-4 mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold">{title}</h2>
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
                className="w-full h-full object-cover"
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
          
          <div className="bg-gray-800 rounded-lg p-4">
            <h3 className="text-lg font-semibold mb-2">Stream Information</h3>
            <p className="text-gray-300 mb-1">Room ID: {streamData?.roomId}</p>
            <p className="text-gray-300">Share this link with others to join your stream:</p>
            <div className="bg-gray-700 rounded p-2 mt-2 flex justify-between">
              <code className="text-sm text-gray-300">
                {window.location.origin}/stream/{streamData?.roomId}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(`${window.location.origin}/stream/${streamData?.roomId}`);
                  alert('Link copied to clipboard!');
                }}
                className="text-blue-400 hover:text-blue-300 text-sm"
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StreamStudio; 