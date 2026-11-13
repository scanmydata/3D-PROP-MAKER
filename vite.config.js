import { defineConfig } from 'vite';

const API_PORT = process.env.API_PORT || 8765;

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
    },
  },
  optimizeDeps: {
    exclude: ['@mkkellogg/gaussian-splats-3d'],
    // pre-bundle at start-up so first use (texture zip, manual) doesn't trigger a page reload
    include: ['fflate', 'marked', 'leaflet', 'meshoptimizer'],
  },
  build: { chunkSizeWarningLimit: 4000 },
});
