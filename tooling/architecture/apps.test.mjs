import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { violation } from './eslint-plugin.mjs';

const root = new URL('../../', import.meta.url);

/** Recursively inspects source files without build output or dependencies. */
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(new URL(`${entry.name}/`, directory))
          : new URL(entry.name, directory),
      ),
    )
  ).flat();
}

test('core packages do not import provider implementations', async () => {
  for (const name of [
    'connections',
    'identity',
    'config',
    'resolution',
    'api-contract',
    'app-host',
  ]) {
    for (const file of await files(new URL(`packages/${name}/src/`, root))) {
      if (!/\.tsx?$/.test(file.pathname) || file.pathname.includes('.test.'))
        continue;
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(
        source,
        /@luma\/(?:app|connector)-(?:shopify|jtl)/,
        file.pathname,
      );
    }
  }
  assert.ok(
    violation(
      'packages/connections/src/infrastructure/runtime.ts',
      'packages/app-shopify/',
    ),
  );
  assert.ok(
    violation('packages/app-host/src/composition.ts', 'packages/app-shopify/'),
  );
});
test('frontend app code is discovered with deferred imports', async () => {
  const source = await readFile(
    new URL('apps/web/src/features/apps/extension.tsx', root),
    'utf8',
  );
  assert.match(source, /import\.meta\.glob/);
  assert.doesNotMatch(source, /eager:\s*true/);
  assert.match(source, /installed/);
});
