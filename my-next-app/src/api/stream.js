import axios from 'axios';

export const createStream = async (title, hostId) => {
  try {
    const response = await axios.post(
      `${process.env.NEXT_PUBLIC_API_URL}/api/streams`,
      { title, hostId }
    );

    console.log('✅ Stream created:', response.data);
    return response;
  } catch (error) {
    console.error('❌ Failed to create stream:', error.message);
    throw error;
  }
};
