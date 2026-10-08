import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const staffRoot = fileURLToPath(new URL('../../staff/', import.meta.url));
const require = createRequire(`${staffRoot}/package.json`);
const { createServer } = await import(require.resolve('vite'));
const server = await createServer({
  root: staffRoot,
  server: {
    host: '127.0.0.1',
    port: Number(process.env.STAFF_WEB_PORT),
    strictPort: true,
  },
});
await server.listen();
process.send?.({ type: 'listening' });
