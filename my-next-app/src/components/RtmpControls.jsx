import React, { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "react-toastify";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import {
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  Save,
  AlertTriangle,
  Loader2,
  RefreshCw,
} from "lucide-react";
import io from "socket.io-client";
import "./RtmpControls.css";
import {
  NEXT_PUBLIC_API_BASE_URL,
  PLATFORMS,
  PLATFORMS_INIT_STATS,
} from "../utils/constants";
import { createStream } from "../api/stream";

// Accept socket as an optional prop
const RtmpControls = ({
  socket: externalSocket,
  roomId,
  userId,
  isHost,
  startStream
}) => {
  // Add state for socket management
  const [socket, setSocket] = useState(externalSocket);
  const [socketConnected, setSocketConnected] = useState(false);
  const [connectionError, setConnectionError] = useState(null);
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectAttempts = useRef(0);

  // Set expandedView to true by default so inputs are visible from the start
  const [expandedView, setExpandedView] = useState(true);
  const [destinations, setDestinations] = useState(PLATFORMS);

  const [isStreaming, setIsStreaming] = useState(false);
  const [showStreamKeys, setShowStreamKeys] = useState({});
  const [platformStatus, setPlatformStatus] = useState(PLATFORMS_INIT_STATS);
  const [savedKeys, setSavedKeys] = useState({});
  const localStorageKey = `rtmp-keys-${userId}`;

  const socketRef = useRef(null);

  const initSocket = useCallback(() => {
    if (socketRef.current) return socketRef.current;
    const newSocket = io(NEXT_PUBLIC_API_BASE_URL, {
      withCredentials: false,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 20000,
      transports: ["websocket", "polling"],
    });

    newSocket.on("connect", () => {
      console.log("Socket connected successfully");
      setSocketConnected(true);
      setConnectionError(null);
      setReconnecting(false);
    });

    socketRef.current = newSocket;
    setSocket(newSocket);
    return newSocket;
  }, [setSocket]);

  // Handle manual reconnection
  const handleManualReconnect = () => {
    console.log("[RtmpControls] Manual reconnect requested");
    setReconnecting(true);
    setConnectionError("Reconnecting...");
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
          setConnectionError("Still trying to connect...");
        }
      }, 2000);
    } else {
      setReconnecting(false);
      setConnectionError("Failed to initialize new connection");
    }
  };

  // Handle socket connection
  useEffect(() => {
    const currentSocket = socket || initSocket();
    if (!currentSocket) return;

    // Socket event handlers
    const handleConnect = () => {
      console.log("[RtmpControls] Socket connected successfully", {
        id: currentSocket.id,
        roomId,
        userId,
      });
      setSocketConnected(true);
      setConnectionError(null);
      setReconnecting(false);
      reconnectAttempts.current = 0;

      // Join room if available
      if (roomId) {
        currentSocket.emit("join-room", roomId, userId);
      }
    };

    const handleDisconnect = (reason) => {
      setSocketConnected(false);

      if (reason === "io server disconnect") {
        // The server has forcefully disconnected the socket
        setConnectionError("Disconnected by server. Try refreshing the page.");
      } else {
        setConnectionError("Connection lost. Attempting to reconnect...");
        setReconnecting(true);
      }
    };

    // Add event listeners
    currentSocket.on("connect", handleConnect);
    currentSocket.on("disconnect", handleDisconnect);

    // Set initial connection state
    setSocketConnected(currentSocket.connected);

    // Clean up
    return () => {
      if (currentSocket) {
        console.log("[RtmpControls] Cleaning up socket event handlers");
        currentSocket.off("connect", handleConnect);
        currentSocket.off("disconnect", handleDisconnect);

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
          setDestinations((prev) =>
            prev.map((dest) => {
              if (parsed[dest.platform]) {
                return { ...dest, streamKey: parsed[dest.platform] };
              }
              return dest;
            })
          );
        }
      } catch (error) {
        console.error("Error loading saved stream keys:", error);
      }
    }
  }, [userId, localStorageKey]);

  // Set up RTMP stream status listeners
  useEffect(() => {
    if (!socket || !socketConnected || !roomId) {
      console.log("Socket not ready for RTMP listeners");
      return;
    }

    console.log("Setting up RTMP stream status listeners");

    const handleStreamStarted = (response) => {
      console.log("RTMP stream started response:", response);

      if (response.success) {
        setIsStreaming(true);

        // Update platform status to show they're active
        const platforms = response.destinations || [];
        setPlatformStatus((prev) => {
          const newStatus = { ...prev };
          platforms.forEach((platform) => {
            newStatus[platform] = { status: "streaming", error: null };
          });
          return newStatus;
        });

        toast.success(response.message || "Streams starting...");
      } else {
        toast.error(response.message || "Failed to start streams");

        // Reset platform statuses
        setPlatformStatus((prev) => {
          const newStatus = { ...prev };
          Object.keys(newStatus).forEach((platform) => {
            newStatus[platform] = { status: "idle", error: response.message };
          });
          return newStatus;
        });
      }
    };

    const handleStreamError = (response = {}) => {
      console.error("RTMP stream error:", response);

      if (response.platform) {
        // Update specific platform status
        setPlatformStatus((prev) => ({
          ...prev,
          [response.platform]: {
            status: "error",
            error: response.message,
          },
        }));

        toast.error(
          `${getPlatformName(response.platform)}: ${response.message}`
        );
      } else {
        // General error
        toast.error(response.message || "Streaming error occurred");
      }
    };

    const handleStreamStopped = (response) => {
      console.log("RTMP stream stopped:", response);

      if (response.success) {
        setIsStreaming(false);

        setPlatformStatus(PLATFORMS_INIT_STATS);

        setDestinations((prev) =>
          prev.map((dest) => ({ ...dest, active: false }))
        );
      }
    };

    const handlePlatformStatus = (statusUpdate) => {
      console.log("Platform status update:", statusUpdate);

      setPlatformStatus((prev) => ({
        ...prev,
        [statusUpdate.platform]: {
          status: statusUpdate.status,
          error: statusUpdate.error || null,
        },
      }));

      // Show notifications for important status changes
      if (statusUpdate.status === "streaming") {
        toast.success(
          `${getPlatformName(statusUpdate.platform)} is now streaming!`
        );
      } else if (statusUpdate.status === "error") {
        toast.error(
          `${getPlatformName(statusUpdate.platform)}: ${statusUpdate.error}`
        );
      }
    };

    // Register event listeners
    socket.on("rtmp-stream-started", handleStreamStarted);
    socket.on("rtmp-stream-error", handleStreamError);
    socket.on("rtmp-stream-stopped", handleStreamStopped);
    socket.on("rtmp-platform-status", handlePlatformStatus);

    // Cleanup
    return () => {
      socket.off("rtmp-stream-started", handleStreamStarted);
      socket.off("rtmp-stream-error", handleStreamError);
      socket.off("rtmp-stream-stopped", handleStreamStopped);
      socket.off("rtmp-platform-status", handlePlatformStatus);
    };
  }, [socket, socketConnected, roomId]);

  // Handle platform toggle
  const handleTogglePlatform = (platform) => {
    console.log("[RtmpControls] Toggle platform", { platform });
    setDestinations((prev) =>
      prev.map((dest) =>
        dest.platform === platform ? { ...dest, enabled: !dest.enabled } : dest
      )
    );
  };

  // Handle input change
  const handleInputChange = (platform, value, field = "streamKey") => {
    setDestinations((prev) =>
      prev.map((dest) =>
        dest.platform === platform ? { ...dest, [field]: value } : dest
      )
    );
  };

  // Handle showing/hiding stream keys
  const handleToggleStreamVisibility = (platform) => {
    setShowStreamKeys((prev) => ({
      ...prev,
      [platform]: !prev[platform],
    }));
  };

  // Save stream keys to localStorage
  const handleSaveKeys = () => {
    const keys = {};
    destinations.forEach((dest) => {
      if (dest.streamKey) {
        keys[dest.platform] = dest.streamKey;
      }
    });

    try {
      localStorage.setItem(localStorageKey, JSON.stringify(keys));
      setSavedKeys(keys);
    } catch (error) {
      console.error("Error saving stream keys:", error);
    }
  };

  // Start streaming
  const handleStartStreaming = async () => {
    try {
      // Filter enabled destinations
      const enabledDestinations = destinations.filter((dest) => dest.enabled);
      console.log("[RtmpControls] Start streaming requested", {
        roomId,
        userId,
        enabledPlatforms: enabledDestinations.map((d) => d.platform),
      });

      // Enhanced logging for debugging RTMP streaming startup
      if (enabledDestinations.length === 0) {
        console.warn("[RtmpControls] No enabled streaming platforms selected", {
          userId,
          roomId,
        });
        return;
      }

      // Validate that all enabled destinations have stream keys
      const missingKeys = enabledDestinations.filter(
        (dest) => !dest.streamKey || !dest.streamKey.trim()
      );
      if (missingKeys.length > 0) {
        const platforms = missingKeys
          .map((d) => getPlatformName(d.platform))
          .join(", ");
        // eslint-disable-next-line no-console
        console.warn(`[RtmpControls] Missing stream keys for: ${platforms}`);
        return;
      }

      // Validate custom RTMP URL if custom platform is enabled
      const customDest = enabledDestinations.find(
        (d) => d.platform === "custom"
      );
      if (customDest && (!customDest.url || !customDest.url.trim())) {
        // eslint-disable-next-line no-console
        console.warn("[RtmpControls] Missing custom RTMP URL");
        return;
      }

      if (!socket || !socketConnected) {
        // eslint-disable-next-line no-console
        console.warn(
          "[RtmpControls] Socket not connected when starting stream"
        );
        return;
      }

      console.log("[RtmpControls] Emitting start-rtmp-stream", {
        roomId,
        userId,
        destinations: enabledDestinations.map((d) => ({
          platform: d.platform,
          hasKey: !!d.streamKey,
          hasUrl: !!d.url,
        })),
      });

      // Update UI to show we're starting
      setPlatformStatus((prev) => {
        const newStatus = { ...prev };
        enabledDestinations.forEach((dest) => {
          newStatus[dest.platform] = { status: "connecting", error: null };
        });
        return newStatus;
      });

      console.log(roomId,"--------------- roomId ------------------------------------");
      // Send start command to backend
      socket.emit("start-rtmp-stream", {
        roomId: roomId,
        userId,
        destinations: enabledDestinations,
      });
    } catch (error) {
      console.error("Error starting stream:", error);
      toast.error("Failed to start streaming: " + error.message);
    }
  };

  // Trigger a short FFmpeg lavfi test stream for a destination
  const handleTestDestination = (dest) => {
    try {
      if (!dest.streamKey || !dest.streamKey.trim()) {
        console.log(
          `Enter a ${getPlatformName(dest.platform)} stream key first`
        );
        return;
      }
      // For custom platform ensure URL exists
      if (dest.platform === "custom" && (!dest.url || !dest.url.trim())) {
        console.log("Enter a custom RTMP URL");
        return;
      }
      const payload = {
        platform: dest.platform,
        url: dest.url,
        streamKey: dest.streamKey,
        duration: 10,
      };
      console.log("[RtmpControls] Emitting test-rtmp-stream", {
        roomId,
        platform: dest.platform,
      });
      setPlatformStatus((prev) => ({
        ...prev,
        [dest.platform]: { status: "connecting", error: null },
      }));
      socket.emit("test-rtmp-stream", payload);
    } catch (e) {
      console.error("Test emit failed", e);
    }
  };

  // Stop streaming
  const handleStopStreaming = () => {
    if (!socket || !socketConnected) {
      console.log("Not connected to server. Please try again later.");
      return;
    }

    socket.emit("stop-rtmp-stream", { roomId });
  };

  // Helper functions for UI
  const getPlatformName = (platform) => {
    switch (platform) {
      case "youtube":
        return "YouTube";
      case "facebook":
        return "Facebook";
      case "twitch":
        return "Twitch";
      case "custom":
        return "Custom RTMP";
      default:
        return platform;
    }
  };

  const getPlatformIcon = (platform) => {
    return "📺";
  };

  const getStatusColor = (status) => {
    switch (status) {
      case "connecting":
        return "bg-yellow-500";
      case "connected":
        return "bg-green-500";
      case "error":
        return "bg-red-500";
      default:
        return "bg-gray-500";
    }
  };

  // Handle cleanup on component unmount (only if we created the socket)
  useEffect(() => {
    return () => {
      if (!externalSocket && socketRef.current) {
        console.log("[RtmpControls] Cleaning up owned socket connection");
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [externalSocket]);

  // Separate useEffect to set up RTMP listeners
  useEffect(() => {
    if (!socket || !socket.connected) {
      console.log("[RtmpControls] Socket not ready for RTMP listeners");
      return;
    }

    return () => {
      if (socket) {
        socket.off("rtmp-status");
        socket.off("stream-started");
        socket.off("stream-ended");
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
          {!socketConnected && connectionError && (
            <div className="bg-red-900/30 p-3 rounded mb-4 flex items-center gap-2 border border-red-700">
              <AlertTriangle size={18} className="text-red-500" />
              <div className="flex-1">
                <p className="font-semibold text-red-200">
                  Socket Connection Error
                </p>
                <p className="text-sm text-red-300">{connectionError}</p>
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
            {destinations.map((dest) => (
              <div
                key={dest.platform}
                className={`platform-config ${
                  dest.active ? "active-platform" : ""
                }`}
              >
                <div className="platform-header">
                  <label className="platform-toggle">
                    <input
                      type="checkbox"
                      checked={dest.enabled}
                      onChange={() => handleTogglePlatform(dest.platform)}
                      disabled={isStreaming || !socketConnected}
                    />
                    <span className="platform-name">
                      {getPlatformIcon(dest.platform)}{" "}
                      {getPlatformName(dest.platform)}
                    </span>

                    {platformStatus[dest.platform]?.status !== "idle" && (
                      <span
                        className={`ml-2 w-2 h-2 rounded-full ${getStatusColor(
                          platformStatus[dest.platform]?.status
                        )}`}
                      ></span>
                    )}
                  </label>

                  {dest.active && <Badge variant="destructive">Active</Badge>}
                </div>

                {/* Stream key inputs - now always visible */}
                <div className="mt-2 space-y-2">
                  <div className="relative stream-key-input">
                    <label className="text-sm text-gray-400 mb-1 block">
                      Stream Key {dest.enabled ? "(Required)" : "(Optional)"}
                    </label>
                    <Input
                      type={showStreamKeys[dest.platform] ? "text" : "password"}
                      placeholder={`${getPlatformName(
                        dest.platform
                      )} Stream Key`}
                      value={dest.streamKey}
                      onChange={(e) =>
                        handleInputChange(dest.platform, e.target.value)
                      }
                      disabled={isStreaming}
                      className="pr-10 stream-key-field"
                    />
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-500"
                      onClick={() =>
                        handleToggleStreamVisibility(dest.platform)
                      }
                    >
                      {showStreamKeys[dest.platform] ? (
                        <EyeOff size={16} />
                      ) : (
                        <Eye size={16} />
                      )}
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    {dest.platform === "custom" && (
                      <>
                        <label className="text-sm text-gray-400 mb-1 block">
                          RTMP URL {dest.enabled ? "(Required)" : "(Optional)"}
                        </label>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleTestDestination(dest)}
                    >
                      Test {getPlatformName(dest.platform)}
                    </Button>
                  </div>

                  {dest.platform === "custom" && (
                    <>
                      <label className="text-sm text-gray-400 mb-1 block">
                        RTMP URL {dest.enabled ? "(Required)" : "(Optional)"}
                      </label>
                      <Input
                        type="text"
                        placeholder="RTMP URL (e.g., rtmp://your-server.com/live)"
                        value={dest.url}
                        onChange={(e) =>
                          handleInputChange(
                            dest.platform,
                            e.target.value,
                            "url"
                          )
                        }
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
                  disabled={
                    !destinations.some((d) => d.enabled && d.streamKey) ||
                    !socketConnected
                  }
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
