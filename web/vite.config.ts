import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:5174';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The dev server proxies to Fastify so the frontend can use same-origin
    // paths, exactly as it will in production where one process serves both.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/media': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
