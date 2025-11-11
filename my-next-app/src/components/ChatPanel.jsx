import { useState, useEffect, useRef } from 'react';
import { Smile, Flag, Trash2, UserX, Send } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import EmojiPicker from 'emoji-picker-react';
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { 
  Card, 
  CardContent, 
  CardFooter, 
  CardHeader, 
  CardTitle 
} from "@/src/components/ui/card";
import { Separator } from "@/src/components/ui/separator";
import { ScrollArea } from "@/src/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/src/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/src/components/ui/dropdown-menu";

const ChatPanel = ({ 
  socket, 
  roomId, 
  userId, 
  username, 
  isHost = false 
}) => {
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [mutedUsers, setMutedUsers] = useState(new Set());
  const chatEndRef = useRef(null);

  useEffect(() => {
    if (!socket) return;

    // Listen for incoming messages
    socket.on('chat-message', (messageData) => {
      // Skip messages from muted users
      if (mutedUsers.has(messageData.userId)) return;
      
      setMessages(prev => [...prev, messageData]);
    });

    // Listen for message reactions
    socket.on('message-reaction', ({ messageId, userId, username, reaction }) => {
      setMessages(prev => prev.map(msg => 
        msg.id === messageId 
          ? {
              ...msg,
              reactions: [...(msg.reactions || []), { userId, username, reaction }]
            }
          : msg
      ));
    });

    // Listen for message deletions
    socket.on('message-deleted', (messageId) => {
      setMessages(prev => prev.filter(msg => msg.id !== messageId));
    });

    // Clean up listeners on unmount
    return () => {
      socket.off('chat-message');
      socket.off('message-reaction');
      socket.off('message-deleted');
    };
  }, [socket, mutedUsers]);

  // Auto-scroll to latest messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = (e) => {
    e.preventDefault();
    if (!message.trim() || !socket) return;

    const messageData = {
      id: `${userId}-${Date.now()}`,
      roomId,
      userId,
      username: username || 'Anonymous',
      text: message.trim(),
      timestamp: new Date().toISOString(),
      reactions: []
    };

    // Emit message to server
    socket.emit('send-chat-message', messageData);
    
    // Add message to local state immediately for responsiveness
    setMessages(prev => [...prev, messageData]);
    
    // Clear input
    setMessage('');
  };

  const addEmoji = (emojiData) => {
    setMessage(prev => prev + emojiData.emoji);
    setEmojiPickerOpen(false);
  };

  const addReaction = (messageId, reaction) => {
    socket.emit('add-reaction', {
      messageId,
      roomId,
      userId,
      username: username || 'Anonymous',
      reaction
    });
  };

  const deleteMessage = (messageId) => {
    socket.emit('delete-message', {
      messageId,
      roomId,
      userId // Only host or message owner can delete
    });
  };

  const muteUser = (targetUserId, targetUsername) => {
    setMutedUsers(prev => new Set(prev).add(targetUserId));
    
    // Filter out existing messages from this user
    setMessages(prev => prev.filter(msg => msg.userId !== targetUserId));
    
    // Notify in chat that a user was muted (only visible to host)
    const systemMessage = {
      id: `system-${Date.now()}`,
      roomId,
      userId: 'system',
      username: 'System',
      text: `${targetUsername} has been muted.`,
      timestamp: new Date().toISOString(),
      isSystem: true
    };
    
    setMessages(prev => [...prev, systemMessage]);
    
    // Inform server about mute action
    if (isHost) {
      socket.emit('mute-user', {
        roomId,
        userId,
        targetUserId,
        targetUsername
      });
    }
  };

  // Format timestamp as relative time (e.g., "5 minutes ago")
  const formatTimestamp = (timestamp) => {
    try {
      return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
    } catch (error) {
      return 'just now';
    }
  };

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="px-4 py-3">
        <CardTitle className="text-base font-medium">Live Chat</CardTitle>
      </CardHeader>
      <Separator />
      
      <CardContent className="flex-1 p-0">
        <ScrollArea className="h-[400px] p-4">
          <div className="space-y-4">
            {messages.length === 0 ? (
              <p className="text-center text-muted-foreground text-sm py-4">
                No messages yet. Be the first to chat!
              </p>
            ) : (
              messages.map((msg) => (
                <div 
                  key={msg.id} 
                  className={`${
                    msg.isSystem 
                      ? 'bg-muted/30 italic' 
                      : msg.userId === userId 
                        ? 'bg-accent/10' 
                        : ''
                  } p-2 rounded-md`}
                >
                  <div className="flex justify-between">
                    <span className="font-medium text-sm">
                      {msg.username}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatTimestamp(msg.timestamp)}
                    </span>
                  </div>
                  
                  <p className="text-sm mt-1">{msg.text}</p>
                  
                  {!msg.isSystem && (
                    <div className="mt-2 flex items-center justify-between">
                      <div className="flex flex-wrap gap-1">
                        {msg.reactions?.map((reaction, index) => (
                          <span 
                            key={`${reaction.userId}-${index}`}
                            className="text-xs bg-muted/40 rounded-full px-2 py-0.5"
                            title={`${reaction.username}`}
                          >
                            {reaction.reaction}
                          </span>
                        ))}
                      </div>
                      
                      <div className="flex gap-1">
                        <Popover open={emojiPickerOpen && msg.id === `emoji-target-${msg.id}`}>
                          <PopoverTrigger asChild>
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              className="h-6 w-6"
                              onClick={() => setEmojiPickerOpen(prev => !prev)}
                            >
                              <Smile className="h-4 w-4" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-full p-0" align="end">
                            <div className="emoji-reaction-selector grid grid-cols-8 gap-1 p-2">
                              {['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉'].map(emoji => (
                                <button
                                  key={emoji}
                                  className="text-xl hover:bg-accent/20 rounded p-1"
                                  onClick={() => {
                                    addReaction(msg.id, emoji);
                                    setEmojiPickerOpen(false);
                                  }}
                                >
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          </PopoverContent>
                        </Popover>
                        
                        {(isHost || msg.userId === userId) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-destructive"
                            onClick={() => deleteMessage(msg.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                        
                        {isHost && msg.userId !== userId && !msg.isSystem && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                              >
                                <Flag className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => muteUser(msg.userId, msg.username)}
                              >
                                <UserX className="h-4 w-4 mr-2" />
                                Mute {msg.username}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>
        </ScrollArea>
      </CardContent>
      
      <Separator />
      
      <CardFooter className="p-4">
        <form onSubmit={sendMessage} className="flex w-full gap-2">
          <div className="relative flex-1">
            <Input
              type="text"
              placeholder="Type a message..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="pr-10"
            />
            <Popover open={emojiPickerOpen && !message.length}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-1/2 transform -translate-y-1/2 h-6 w-6"
                  onClick={() => setEmojiPickerOpen(!emojiPickerOpen)}
                >
                  <Smile className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="p-0">
                <EmojiPicker
                  onEmojiClick={addEmoji}
                  width={300}
                  height={400}
                  previewConfig={{ showPreview: false }}
                />
              </PopoverContent>
            </Popover>
          </div>
          <Button type="submit" size="icon">
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </CardFooter>
    </Card>
  );
};

export default ChatPanel; 