// @ts-nocheck
'use client'
import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
// Import Shadcn UI components
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Loader2 } from "lucide-react";
import ChatPanel from '../../components/ChatPanel';
import RtmpControls from '../../components/RtmpControls';

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
  
  // API URL from environment variables
  const API_URL = import.meta.env.VITE_API_URL;
  
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
        const response = await axios.get(`${API_URL}/api/streams?roomId=${roomId}`);
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
  }, [roomId, API_URL]);

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
      // Connect to socket server with API URL from environment variables
      console.log("Connecting to socket server at:", API_URL);
      socketRef.current = io(API_URL);
      
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
  }, [roomId, viewerId, hostId, API_URL]); // Added API_URL to dependencies
  
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
    axios.get(`${API_URL}/api/streams?roomId=${roomId}`)
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
    <div className="container max-w-4xl mx-auto p-4 space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">{streamInfo?.title || 'Live Stream'}</h1>
        <Button variant="outline" onClick={() => navigate('/')}>
          Back to Home
        </Button>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <Card>
            <CardContent className="p-0">
              <AspectRatio ratio={16/9} className="bg-black relative">
                {/* Main video element */}
                <video 
                  ref={videoRef} 
                  autoPlay 
                  playsInline
                  controls  
                  className="w-full h-full object-contain"
                />
                
                {/* Connection status overlays */}
                {connecting && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-70">
                    <div className="text-center space-y-2">
                      <Loader2 className="h-10 w-10 animate-spin mx-auto" />
                      <p className="text-lg">Connecting to stream...</p>
                    </div>
                  </div>
                )}
                
                {connectionError && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-70">
                    <div className="text-center max-w-md p-6">
                      <div className="text-red-500 text-5xl mb-3">⚠️</div>
                      <p className="text-xl mb-4">{connectionError}</p>
                      <Button variant="default" onClick={retryConnection}>
                        Try Again
                      </Button>
                    </div>
                  </div>
                )}
                
                {/* RTMP status indicator for viewers */}
                {connected && (
                  <div className="absolute top-4 right-4">
                    <RtmpControls 
                      socket={socketRef.current}
                      roomId={roomId}
                      userId={viewerId}
                      isHost={false}
                    />
                  </div>
                )}
              </AspectRatio>
            </CardContent>
            
            {connected && (
              <CardFooter className="flex flex-col items-start p-4">
                <div className="flex items-center w-full">
                  <Badge variant="destructive" className="mr-2">LIVE</Badge>
                  <p className="text-muted-foreground">Room: {roomId}</p>
                </div>
                <h2 className="text-xl font-semibold mt-2">{streamInfo?.title}</h2>
              </CardFooter>
            )}
          </Card>
        </div>
        
        {/* Add chat panel */}
        <div>
          <ChatPanel 
            socket={socketRef.current}
            roomId={roomId}
            userId={viewerId}
            username={`Viewer_${viewerId.substring(0, 4)}`}
            isHost={false}
          />
        </div>
      </div>
      
      {/* Debug info - useful for troubleshooting */}
      <Card className="bg-muted">
        <CardHeader>
          <CardTitle className="text-sm">Debug Info</CardTitle>
        </CardHeader>
        <CardContent className="text-xs space-y-1">
          <p>API URL: {API_URL}</p>
          <p>Room ID: {roomId}</p>
          <p>Host ID: {hostId || 'Unknown'}</p>
          <p>Connected: {connected ? 'Yes' : 'No'}</p>
          <p>Connection Attempted: {connectionAttemptedRef.current ? 'Yes' : 'No'}</p>
          <p>Host Stream: {hostStream ? 'Received' : 'Not received'}</p>
          <p>Video Tracks: {hostStream ? hostStream.getVideoTracks().length : 0}</p>
          <p>Audio Tracks: {hostStream ? hostStream.getAudioTracks().length : 0}</p>
          {connectionError && <p className="text-red-500">Error: {connectionError}</p>}
        </CardContent>
      </Card>
    </div>
  );
};

export default ViewStream; 