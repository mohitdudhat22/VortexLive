import React, { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'react-toastify';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Eye, EyeOff, ChevronDown, ChevronUp, Save, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import io from 'socket.io-client';
import './RtmpControls.css';

// Accept socket as an optional prop
const RtmpControls = ({ socket: externalSocket, roomId, userId, isHost }) => {
  // Add state for socket management
  const [socket, setSocket] = useState(externalSocket);
  const [socketConnected, setSocketConnected] = useState(false);
  const [connectionError, setConnectionError] = useState(null);
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;
  
  // Set expandedView to true by default so inputs are visible from the start
  const [expandedView, setExpandedView] = useState(true);
  const [destinations, setDestinations] = useState([
    { platform: 'youtube', streamKey: '', url: 'rtmp://a.rtmp.youtube.com/live2', active: false, enabled: true },
    { platform: 'facebook', streamKey: '', url: 'rtmp://live-api-s.facebook.com:80/rtmp', active: false, enabled: true },
    { platform: 'twitch', streamKey: '', url: 'rtmp://live.twitch.tv/app', active: false, enabled: true },
    { platform: 'custom', streamKey: '', url: '', active: false, enabled: false },
  ]);
  
  const [isStreaming, setIsStreaming] = useState(false);
  const [showStreamKeys, setShowStreamKeys] = useState({});
  const [platformStatus, setPlatformStatus] = useState({
    youtube: { status: 'idle', error: null },
    facebook: { status: 'idle', error: null },
    twitch: { status: 'idle', error: null },
    custom: { status: 'idle', error: null }
  });
  const [savedKeys, setSavedKeys] = useState({});
  const localStorageKey = `rtmp-keys-${userId}`;
  
  const socketRef = useRef(null);

  const initSocket = useCallback(() => {
    if (socketRef.current) return socketRef.current;

    const API_URL = import.meta.env.VITE_API_URL || window.location.origin;
    
    console.log('Initializing socket connection to:', API_URL);
    
    const newSocket = io(API_URL, {
      withCredentials: false,
      reconnectionAttempts: 10,     // Increased from 5
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 20000,               // Adding connection timeout
      transports: ['websocket', 'polling']
    });

    newSocket.on('connect', () => {
      console.log('Socket connected successfully');
      setSocketConnected(true);
      setConnectionError(null);
      setReconnecting(false);
    });

    newSocket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
      setSocketConnected(false);
      setConnectionError(`Connection error: ${error.message}`);
    });

    socketRef.current = newSocket;
    setSocket(newSocket);
    return newSocket;
  }, [setSocket]);
  
  // Handle manual reconnection
  const handleManualReconnect = () => {
    setReconnecting(true);
    setConnectionError('Reconnecting...');
    reconnectAttempts.current = 0;
    
    // Clean up old socket if we created it
    if (socket && !externalSocket) {
      socket.disconnect();
    }
    
    // Initialize a new socket connection
    const newSocket = initSocket();
    
    if (newSocket) {
      setSocket(newSocket);
      
      // Check connection status after a delay
      setTimeout(() => {
        if (!newSocket.connected) {
          setConnectionError('Still trying to connect...');
        }
      }, 2000);
    } else {
      setReconnecting(false);
      setConnectionError('Failed to initialize new connection');
    }
  };
  
  // Handle socket connection
  useEffect(() => {
    const currentSocket = socket || initSocket();
    if (!currentSocket) return;
    
    // Socket event handlers
    const handleConnect = () => {
      console.log('Socket connected successfully');
      setSocketConnected(true);
      setConnectionError(null);
      setReconnecting(false);
      reconnectAttempts.current = 0;
      
      // Join room if available
      if (roomId) {
        console.log(`Joining room ${roomId}`);
        currentSocket.emit('join-room', roomId, userId);
      }
    };
    
    const handleDisconnect = (reason) => {
      console.log('Socket disconnected:', reason);
      setSocketConnected(false);
      
      if (reason === 'io server disconnect') {
        // The server has forcefully disconnected the socket
        setConnectionError('Disconnected by server. Try refreshing the page.');
      } else {
        setConnectionError('Connection lost. Attempting to reconnect...');
        setReconnecting(true);
      }
    };
    
    const handleConnectError = (error) => {
      console.error('Socket connection error:', error);
      reconnectAttempts.current++;
      
      if (reconnectAttempts.current >= maxReconnectAttempts) {
        setReconnecting(false);
        setConnectionError(`Connection failed after ${maxReconnectAttempts} attempts. Check your network or server status.`);
      } else {
        setConnectionError(`Connection error (attempt ${reconnectAttempts.current}/${maxReconnectAttempts}): ${error.message || 'Unknown error'}`);
      }
    };
    
    const handleReconnect = (attemptNumber) => {
      console.log(`Socket reconnection attempt #${attemptNumber}`);
      setReconnecting(true);
      reconnectAttempts.current = attemptNumber;
    };
    
    const handleReconnectFailed = () => {
      console.error('Socket reconnection failed after all attempts');
      setReconnecting(false);
      setConnectionError('Failed to reconnect after multiple attempts. Please refresh the page.');
    };
    
    // Add event listeners
    currentSocket.on('connect', handleConnect);
    currentSocket.on('disconnect', handleDisconnect);
    currentSocket.on('connect_error', handleConnectError);
    currentSocket.on('reconnect', handleReconnect);
    currentSocket.on('reconnect_attempt', handleReconnect);
    currentSocket.on('reconnect_failed', handleReconnectFailed);
    
    // Set initial connection state
    setSocketConnected(currentSocket.connected);
    if (!currentSocket.connected) {
      setConnectionError('Connecting to server...');
    }
    
    // Clean up
    return () => {
      if (currentSocket) {
        currentSocket.off('connect', handleConnect);
        currentSocket.off('disconnect', handleDisconnect);
        currentSocket.off('connect_error', handleConnectError);
        currentSocket.off('reconnect', handleReconnect);
        currentSocket.off('reconnect_attempt', handleReconnect);
        currentSocket.off('reconnect_failed', handleReconnectFailed);
        
        // Only disconnect if we created this socket
        if (!externalSocket && currentSocket) {
          currentSocket.disconnect();
        }
      }
    };
  }, [externalSocket, roomId, userId]);

  // Load saved stream keys from localStorage
  useEffect(() => {
    if (userId) {
      try {
        const savedData = localStorage.getItem(localStorageKey);
        if (savedData) {
          const parsed = JSON.parse(savedData);
          setSavedKeys(parsed);
          
          // Apply saved keys to destinations
          setDestinations(prev => prev.map(dest => {
            if (parsed[dest.platform]) {
              return { ...dest, streamKey: parsed[dest.platform] };
            }
            return dest;
          }));
        }
      } catch (error) {
        console.error('Error loading saved stream keys:', error);
      }
    }
  }, [userId, localStorageKey]);

  // Set up RTMP stream status listeners
  useEffect(() => {
    if (!socket || !socketConnected || !roomId) {
      console.log('Socket not ready for RTMP listeners');
      return;
    }
    
    console.log('Setting up RTMP stream status listeners');

    // Listen for RTMP stream status updates
    const handleStreamStarted = (response) => {
      console.log('RTMP stream started:', response);
      if (response.success) {
        // Add null check for destinations
        const destinations = response.destinations || [];
        setIsStreaming(destinations.length > 0);
        
        // Update active destinations with null check
        setDestinations(prev => prev.map(dest => {
          const active = destinations.some(d => d.platform === dest.platform);
          return { ...dest, active };
        }));
        
        toast.success('Stream started successfully!');
      } else {
        toast.error(`Failed to start stream: ${response.error}`);
      }
    };
    
    const handleStreamStopped = (response) => {
      console.log('RTMP stream stopped:', response);
      if (response.success) {
        setIsStreaming(false);
        
        // Update active destinations
        setDestinations(prev => prev.map(dest => ({ ...dest, active: false })));
        
        toast.info('Stream stopped.');
      } else {
        toast.error(`Failed to stop stream: ${response.error}`);
      }
    };
    
    const handlePlatformStatus = (statusUpdate) => {
      console.log('RTMP platform status update:', statusUpdate);
      setPlatformStatus(prev => ({
        ...prev,
        [statusUpdate.platform]: {
          status: statusUpdate.status,
          error: statusUpdate.error || null
        }
      }));
      
      // Show toast for errors
      if (statusUpdate.status === 'error' && statusUpdate.error) {
        toast.error(`${getPlatformName(statusUpdate.platform)} error: ${statusUpdate.error}`);
      }
      
      // Show toast for successful connections
      if (statusUpdate.status === 'connected') {
        toast.success(`${getPlatformName(statusUpdate.platform)} connected successfully!`);
      }
    };
    
    socket.on('rtmp-stream-started', handleStreamStarted);
    socket.on('rtmp-stream-stopped', handleStreamStopped);
    socket.on('rtmp-platform-status', handlePlatformStatus);
    
    return () => {
      socket.off('rtmp-stream-started', handleStreamStarted);
      socket.off('rtmp-stream-stopped', handleStreamStopped);
      socket.off('rtmp-platform-status', handlePlatformStatus);
    };
  }, [socket, socketConnected, roomId]);
  
  // Handle platform toggle
  const handleTogglePlatform = (platform) => {
    setDestinations(prev => prev.map(dest => 
      dest.platform === platform 
        ? { ...dest, enabled: !dest.enabled } 
        : dest
    ));
  };
  
  // Handle input change
  const handleInputChange = (platform, value, field = 'streamKey') => {
    setDestinations(prev => prev.map(dest => 
      dest.platform === platform 
        ? { ...dest, [field]: value } 
        : dest
    ));
  };
  
  // Handle showing/hiding stream keys
  const handleToggleStreamVisibility = (platform) => {
    setShowStreamKeys(prev => ({
      ...prev,
      [platform]: !prev[platform]
    }));
  };
  
  // Save stream keys to localStorage
  const handleSaveKeys = () => {
    const keys = {};
    destinations.forEach(dest => {
      if (dest.streamKey) {
        keys[dest.platform] = dest.streamKey;
      }
    });
    
    try {
      localStorage.setItem(localStorageKey, JSON.stringify(keys));
      setSavedKeys(keys);
      toast.success('Stream keys saved!');
    } catch (error) {
      console.error('Error saving stream keys:', error);
      toast.error('Failed to save stream keys.');
    }
  };
  
  // Start streaming
  const handleStartStreaming = () => {
    try {
      setIsStreaming(true);
      
      // Filter enabled destinations
      const enabledDestinations = destinations.filter(dest => dest.enabled);
      
      if (enabledDestinations.length === 0) {
        toast.warning('Please enable at least one streaming platform');
        setIsStreaming(false);
        return;
      }
      
      console.log('Starting RTMP stream with destinations: ', enabledDestinations);
      
      // Fix event name to match server-side listener
      socket.emit('start-rtmp-stream', { 
        roomId, 
        userId, // Make sure to include the userId parameter
        destinations: enabledDestinations 
      });
    } catch (error) {
      console.error('Error starting stream:', error);
      toast.error('Failed to start streaming');
      setIsStreaming(false);
    }
  };
  
  // Stop streaming
  const handleStopStreaming = () => {
    if (!socket || !socketConnected) {
      toast.error('Not connected to server. Please try again later.');
      return;
    }
    
    console.log('Stopping RTMP stream');
    socket.emit('stop-rtmp', { roomId });
  };
  
  // Helper functions for UI
  const getPlatformName = (platform) => {
    switch (platform) {
      case 'youtube': return 'YouTube';
      case 'facebook': return 'Facebook';
      case 'twitch': return 'Twitch';
      case 'custom': return 'Custom RTMP';
      default: return platform;
    }
  };
  
  const getPlatformIcon = (platform) => {
    return '📺'; // Use actual icons in a real implementation
  };
  
  const getStatusColor = (status) => {
    switch (status) {
      case 'connecting': return 'bg-yellow-500';
      case 'connected': return 'bg-green-500';
      case 'error': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };
  
  // Handle cleanup on component unmount
  useEffect(() => {
    const currentSocket = initSocket();
    
    // Setup socket event listeners here...
    
    return () => {
      if (socketRef.current) {
        console.log('Cleaning up socket connection');
        // Remove all listeners before disconnecting
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [initSocket]);

  // Separate useEffect to set up RTMP listeners
  useEffect(() => {
    if (!socket || !socket.connected) {
      console.log('Socket not ready for RTMP listeners');
      return;
    }
    
    console.log('Setting up RTMP listeners');
    
    // Set up your RTMP listeners here...
    
    return () => {
      if (socket) {
        // Only remove specific RTMP-related listeners
        socket.off('rtmp-status');
        socket.off('stream-started');
        socket.off('stream-ended');
        // ... other RTMP event listeners
      }
    };
  }, [socket, socket?.connected]);
  
  if (!isHost) return null;
  
  return (
    <div className="rtmp-controls-container">
      <div 
        className="rtmp-controls-header"
        onClick={() => setExpandedView(!expandedView)}
      >
        <h3 className="flex items-center">
          {isStreaming && (
            <span className="streaming-indicator mr-2">
              <span className="live-dot"></span>LIVE
            </span>
          )}
          External Streaming
          {socketConnected ? (
            <span className="ml-2 w-2 h-2 rounded-full bg-green-500"></span>
          ) : (
            <span className="ml-2 w-2 h-2 rounded-full bg-red-500"></span>
          )}
        </h3>
        <span className="expand-icon">
          {expandedView ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </div>
      
      {expandedView && (
        <div className="rtmp-controls-body">
          {!socketConnected && (
            <div className="bg-red-900/30 p-3 rounded mb-4 flex items-center gap-2 border border-red-700">
              <AlertTriangle size={18} className="text-red-500" />
              <div className="flex-1">
                <p className="font-semibold text-red-200">Socket Connection Error</p>
                <p className="text-sm text-red-300">
                  {connectionError || 'Not connected to server.'}
                </p>
                <p className="text-xs mt-1 text-red-400">Room: {roomId}</p>
              </div>
              <Button 
                size="sm" 
                variant="outline" 
                className="border-red-700 hover:bg-red-700/30"
                onClick={handleManualReconnect}
                disabled={reconnecting}
              >
                {reconnecting ? (
                  <Loader2 size={16} className="animate-spin mr-1" />
                ) : (
                  <RefreshCw size={16} className="mr-1" />
                )}
                Reconnect
              </Button>
            </div>
          )}
          
          <div className="platform-list">
            {destinations.map(dest => (
              <div key={dest.platform} className={`platform-config ${dest.active ? 'active-platform' : ''}`}>
                <div className="platform-header">
                  <label className="platform-toggle">
                    <input
                      type="checkbox"
                      checked={dest.enabled}
                      onChange={() => handleTogglePlatform(dest.platform)}
                      disabled={isStreaming || !socketConnected}
                    />
                    <span className="platform-name">
                      {getPlatformIcon(dest.platform)} {getPlatformName(dest.platform)}
                    </span>
                    
                    {platformStatus[dest.platform]?.status !== 'idle' && (
                      <span 
                        className={`ml-2 w-2 h-2 rounded-full ${getStatusColor(platformStatus[dest.platform]?.status)}`}
                      ></span>
                    )}
                  </label>
                  
                  {dest.active && (
                    <Badge variant="destructive">
                      Active
                    </Badge>
                  )}
                </div>
                
                {/* Stream key inputs - now always visible */}
                <div className="mt-2 space-y-2">
                  <div className="relative stream-key-input">
                    <label className="text-sm text-gray-400 mb-1 block">
                      Stream Key {dest.enabled ? '(Required)' : '(Optional)'}
                    </label>
                    <Input
                      type={showStreamKeys[dest.platform] ? "text" : "password"}
                      placeholder={`${getPlatformName(dest.platform)} Stream Key`}
                      value={dest.streamKey}
                      onChange={(e) => handleInputChange(dest.platform, e.target.value)}
                      disabled={isStreaming}
                      className="pr-10 stream-key-field"
                    />
                    <button 
                      type="button"
                      className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-500"
                      onClick={() => handleToggleStreamVisibility(dest.platform)}
                    >
                      {showStreamKeys[dest.platform] ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  
                  {dest.platform === 'custom' && (
                    <>
                      <label className="text-sm text-gray-400 mb-1 block">
                        RTMP URL {dest.enabled ? '(Required)' : '(Optional)'}
                      </label>
                      <Input
                        type="text"
                        placeholder="RTMP URL (e.g., rtmp://your-server.com/live)"
                        value={dest.url}
                        onChange={(e) => handleInputChange(dest.platform, e.target.value, 'url')}
                        disabled={isStreaming}
                      />
                    </>
                  )}
                  
                  {platformStatus[dest.platform]?.error && (
                    <div className="text-red-500 text-sm mt-1">
                      {platformStatus[dest.platform].error}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          
          <div className="flex justify-between mt-6">
            <Button 
              size="sm"
              variant="outline"
              onClick={handleSaveKeys}
              disabled={isStreaming}
            >
              <Save size={16} className="mr-1" /> Save Keys
            </Button>
            
            <div className="space-x-2">
              {!isStreaming ? (
                <Button 
                  variant="default" 
                  onClick={handleStartStreaming}
                  disabled={!destinations.some(d => d.enabled && d.streamKey) || !socketConnected}
                >
                  Start Streaming
                </Button>
              ) : (
                <Button 
                  variant="destructive" 
                  onClick={handleStopStreaming}
                  disabled={!socketConnected}
                >
                  Stop Streaming
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RtmpControls; 