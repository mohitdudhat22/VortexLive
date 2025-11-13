import axios from 'axios';

export const createStream = async (title, hostId) => {
  try {
    const response = await axios.post(
      `${process.env.NEXT_PUBLIC_API_URL}/streams`,
      { title, hostId }
    );

    console.log('✅ Stream created:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ Failed to create stream:', error.message);
    throw error;
  }
};

export const markStream = async (streamDataRef) => {
  try {
    await axios.patch(`${NEXT_PUBLIC_API_URL}/streams/${streamDataRef.current._id}/end`);
  } catch (error) {
    console.warn('Failed to mark stream ended on API', e);
    return error
  }
}
