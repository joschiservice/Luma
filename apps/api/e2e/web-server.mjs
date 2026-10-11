import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));
if (!existsSync(`${webRoot}dist/server/server.js`))
  throw new Error('Build @luma/web first; pnpm test:browser does');

const require = createRequire(`${webRoot}/package.json`);

const { preview } = await import(require.resolve('vite'));

// Journeys use the production build that `pnpm test:browser` prepares; compiling the app
// on demand would cost every test seconds. TanStack Start's preview server loads the
// server bundle relative to the working directory.
process.chdir(webRoot);
await preview({
  root: webRoot,
  preview: {
    host: '127.0.0.1',
    port: Number(process.env.TEST_WEB_PORT),
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.TEST_API_ORIGIN,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});

process.send?.({ type: 'listening' });
