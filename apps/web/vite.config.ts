import { defineConfig, loadEnv } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '');
  return {
    plugins: [tailwindcss(), tanstackStart(), react()],
    server: {
      host: '127.0.0.1',
      port: Number(process.env.WEB_PORT ?? env.WEB_PORT ?? 3000),
      strictPort: true,
      proxy: {
        '/api': {
          target:
            process.env.API_PROXY_TARGET ??
            env.API_PROXY_TARGET ??
            'http://127.0.0.1:3001',
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
