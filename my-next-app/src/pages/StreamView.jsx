import RtmpControls from '../components/RtmpControls';

function StreamView() {
  // ... your existing code
  
  return (
    <div className="stream-view">
      {/* Your existing stream components */}
      
      {/* Add RTMP Controls - ideally in your stream control panel */}
      <RtmpControls 
        socket={socket}
        roomId={roomId}
        userId={currentUser?.id} 
        isHost={isHost} 
      />
      
      {/* Rest of your stream UI */}
    </div>
  );
}