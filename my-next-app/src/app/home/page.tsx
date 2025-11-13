// @ts-nocheck
'use client'
import { useState, useEffect } from 'react';
import axios from 'axios';
import { NEXT_PUBLIC_API_URL } from '@/src/utils/constants';
import { useRouter } from 'next/navigation'

const HomePage = () => {
  const [streams, setStreams] = useState([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const fetchStreams = async () => {
      try {
        const res = await axios.get(NEXT_PUBLIC_API_URL +'/streams');
        setStreams(res.data);
        setLoading(false);
      } catch (error) {
        console.error('Error fetching streams:', error);
        setLoading(false);
      }
    };

    fetchStreams();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-2xl">Loading streams...</div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-8">Live Streams</h1>
      
      {streams.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-xl mb-4">No streams are currently live</p>
          <div onClick={() => router.push("/stream-studio")} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg">
            Start Streaming
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {streams.map((stream) => (
            <div key={stream._id} className="bg-gray-800 rounded-lg overflow-hidden shadow-lg">
              <div className="p-6">
                <h2 className="text-xl font-semibold mb-2">{stream.title}</h2>
                <p className="text-gray-400 mb-4">Host: {stream.hostId}</p>
                <div 
                  onClick={ () => router.push(`/stream/${stream.roomId}`)} 
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded block text-center"
                >
                  Join Stream
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default HomePage; 