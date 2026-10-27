// Regenerates src/routeTree.gen.ts with the TanStack Start plugin from vite.config.ts, which
// writes the tree while Vite resolves its config. Dev and build use the same plugin, so every
// path produces the same file; the router CLI omits Start's Register declaration. In CI, a
// tree that changes here was committed stale, so the run fails.
import { readFile } from 'node:fs/promises';

import { resolveConfig } from 'vite';

const root = new URL('..', import.meta.url);
const tree = new URL('src/routeTree.gen.ts', root);
const read = () => readFile(tree, 'utf8').catch(() => '');

const before = await read();
await resolveConfig({ root: root.pathname, logLevel: 'warn' }, 'build');
if (process.env.CI && (await read()) !== before) {
  console.error(
    'apps/web/src/routeTree.gen.ts was out of date. Run `pnpm --filter @luma/web typecheck` and commit it.',
  );
  process.exitCode = 1;
}
