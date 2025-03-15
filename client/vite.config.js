import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import tailwindcss from 'tailwindcss';
import path from 'path';
// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      // To add specific polyfills for WebRTC and related APIs
      include: ['buffer', 'process', 'stream', 'events', 'util'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 3000,
    open: true,
  },
  resolve: {
    alias: {
      stream: 'stream-browserify',
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
