import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import { fail, root, run } from './process.mjs';

/**
 * Names the ESLint cache after everything that decides lint results besides the linted file.
 * ESLint keys cached results by file content and serialized configuration, not by rule code,
 * so an edited local rule or an upgraded plugin would otherwise reuse stale passes.
 */
function cacheKey() {
  const local = ['tooling/architecture', 'tooling/style'].flatMap((directory) =>
    readdirSync(join(root, directory))
      .filter((file) => file.endsWith('.mjs') && !file.endsWith('.test.mjs'))
      .map((file) => join(directory, file)),
  );
  const hash = createHash('sha256');
  for (const file of ['eslint.config.mjs', 'pnpm-lock.yaml', ...local.sort()])
    hash.update(file).update(readFileSync(join(root, file)));

  return hash.digest('hex').slice(0, 16);
}

try {
  const key = cacheKey();
  const caches = join(root, 'node_modules/.cache/eslint');
  // Caches for earlier rules or plugin versions are never read again.
  for (const entry of existsSync(caches) ? readdirSync(caches) : [])
    if (entry !== key)
      rmSync(join(caches, entry), { recursive: true, force: true });
  await run(
    'eslint',
    [
      '.',
      '--max-warnings',
      '0',
      // Worker threads pay off on a cold cache; half the cores leaves room for parallel checks.
      `--concurrency=${Math.max(1, Math.floor(availableParallelism() / 2))}`,
      '--cache',
      '--cache-strategy',
      'content',
      '--cache-location',
      `node_modules/.cache/eslint/${key}/`,
      ...process.argv.slice(2),
    ],
    { env: process.env },
  );
} catch (error) {
  fail(error);
}
