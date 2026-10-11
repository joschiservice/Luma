import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const staffRoot = fileURLToPath(new URL('../../staff/', import.meta.url));
if (!existsSync(`${staffRoot}dist/index.html`))
  throw new Error('Build @luma/staff-web first; pnpm test:browser does');
const require = createRequire(`${staffRoot}/package.json`);
const { preview } = await import(require.resolve('vite'));
// Serves the production build that `pnpm test:browser` prepares; the configured API proxy
// applies to preview as well.
await preview({
  root: staffRoot,
  preview: {
    host: '127.0.0.1',
    port: Number(process.env.STAFF_WEB_PORT),
    strictPort: true,
  },
});
process.send?.({ type: 'listening' });
