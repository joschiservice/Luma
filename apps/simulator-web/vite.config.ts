import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The simulator host serves `dist/index.html` at `/` and `dist/assets/*` beside its API.
export default defineConfig({
  plugins: [tailwindcss(), react()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    // One local page: React, Base UI and zod form a single ~190 kB gzip bundle on purpose.
    chunkSizeWarningLimit: 700,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': process.env.LUMA_SIMULATOR_ORIGIN ?? 'http://127.0.0.1:5890',
    },
  },
});
