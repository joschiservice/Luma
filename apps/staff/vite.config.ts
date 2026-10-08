import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  const target = process.env.STAFF_API_PROXY_TARGET;
  const port = Number(process.env.STAFF_WEB_PORT);

  return {
    plugins: [tailwindcss(), react()],
    server: {
      host: '127.0.0.1',
      ...(Number.isInteger(port) && port > 0 ? { port } : {}),
      strictPort: true,
      ...(target
        ? {
            proxy: {
              '/api': {
                target,
                changeOrigin: false,
                rewrite: (path: string) => path.replace(/^\/api/, ''),
              },
            },
          }
        : {}),
    },
  };
});
