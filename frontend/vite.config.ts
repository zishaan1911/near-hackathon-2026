import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Reads SILICA_<NAME>.
function readEnv(name: string): string | undefined {
  return process.env[`SILICA_${name}`];
}

export default defineConfig({
  plugins: [react()],
  // wallet-selector and its @near-js dependencies expect a Node-style global.
  define: {
    global: 'globalThis',
  },
  server: {
    port: 5173,
    // The repo lives on /mnt/c (Windows filesystem); inotify-based change
    // detection is unreliable there, so poll instead. Without this, edits
    // made outside WSL are never noticed and HMR silently stops.
    watch: {
      usePolling: true,
      interval: 300,
    },
    // The API server runs separately (`npm run dev` in server/). Proxying keeps
    // the browser same-origin, so no CORS config is needed on the server.
    proxy: {
      '/api': {
        target: readEnv('API_URL') || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
  },
});
