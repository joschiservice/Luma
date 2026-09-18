import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));
const require = createRequire(`${webRoot}/package.json`);
const { createServer } = await import(require.resolve('vite'));
const server = await createServer({
  root: webRoot,
  server: {
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
await server.listen();
process.send?.({ type: 'listening' });
