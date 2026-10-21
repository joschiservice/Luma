import { existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));
if (!existsSync(`${webRoot}dist/server/server.js`))
  throw new Error('Build @luma/web first; pnpm test:browser does');

const require = createRequire(`${webRoot}/package.json`);

const { preview } = await import(require.resolve('vite'));

// A browser worker reuses one web server for its journeys, each with its own API. Requests
// for `/api` go through this forwarder, whose target a journey sets with a `target` message.
let target = process.env.TEST_API_ORIGIN;
const forwarder = createServer((incoming, outgoing) => {
  if (!target) {
    outgoing.writeHead(503).end('No journey API is set');

    return;
  }
  const upstream = request(
    new URL(incoming.url ?? '/', target),
    { method: incoming.method, headers: incoming.headers },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      // A journey's API closes while its event streams are still open.
      response.on('error', () => outgoing.destroy());
    },
  );
  upstream.on('error', () => outgoing.destroy());
  incoming.on('error', () => upstream.destroy());
  outgoing.on('close', () => upstream.destroy());
  incoming.pipe(upstream);
});
await new Promise((resolve) => forwarder.listen(0, '127.0.0.1', resolve));
const address = forwarder.address();
if (!address || typeof address === 'string')
  throw new Error('Forwarder has no port');
process.on('message', (message) => {
  if (message?.type !== 'target') return;
  target = message.origin;
  process.send?.({ type: 'target-set', origin: target });
});

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
        target: `http://127.0.0.1:${address.port}`,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});

process.send?.({ type: 'listening' });
