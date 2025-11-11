const NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || (typeof window !== 'undefined' ? 'http://localhost:5000' : 'http://localhost:5000')

export { NEXT_PUBLIC_API_URL }