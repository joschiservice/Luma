import { lumaI18n } from '@luma/i18n/vite';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { fumadocsMdx } from 'fumadocs-mdx/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '');

  return {
    plugins: [
      lumaI18n(),
      fumadocsMdx({ index: false }),
      tailwindcss(),
      tanstackStart(),
      react(),
    ],
    build: {
      rolldownOptions: {
        output: {
          // Names each workspace app's lazy UI chunk after the app, such as `app-jtl-….js`,
          // so a page load shows which app code it fetched.
          chunkFileNames: (chunk) => {
            const app = /packages\/apps\/([^/]+)\/src\/web\/index\.tsx$/.exec(
              chunk.facadeModuleId ?? '',
            )?.[1];

            return app
              ? `assets/app-${app}-[hash].js`
              : 'assets/[name]-[hash].js';
          },
        },
      },
    },
    server: {
      host: '127.0.0.1',
      allowedHosts: ['luma-dev.tail2dda1b.ts.net'],
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
