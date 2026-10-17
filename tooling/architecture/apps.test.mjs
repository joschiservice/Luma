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

/** Workspace app packages present in this checkout. */
async function appNames() {
  const entries = await readdir(new URL('packages/apps/', root), {
    withFileTypes: true,
  });

  return entries.filter((entry) => entry.isDirectory()).map((e) => e.name);
}

test('core packages do not import provider implementations', async () => {
  const apps = await appNames();
  assert.ok(apps.length > 0);
  const provider = new RegExp(
    `@luma/(?:app|connector)-(?:${apps.join('|')})(?![\\w-])`,
  );
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
      assert.doesNotMatch(source, provider, file.pathname);
    }
  }
  for (const app of apps) {
    assert.ok(
      violation(
        'packages/connections/src/infrastructure/runtime.ts',
        `packages/app-${app}/`,
      ),
      app,
    );
    assert.ok(
      violation('packages/app-host/src/composition.ts', `packages/app-${app}/`),
      app,
    );
    assert.ok(
      violation(
        'packages/connections/src/infrastructure/runtime.ts',
        `packages/apps/${app}/src/index.ts`,
      ),
      app,
    );
  }
});

test('app layers import only inward, and apps never import each other', async () => {
  const file = (app, path) => `packages/apps/${app}/src/${path}`;
  for (const app of await appNames()) {
    for (const [from, to] of [
      ['application/a.ts', 'domain/b.ts'],
      ['infrastructure/a.ts', 'application/b.ts'],
      ['infrastructure/a.ts', 'config.ts'],
      ['api/a.ts', 'application/b.ts'],
      ['web/a.ts', 'domain/b.ts'],
      ['index.ts', 'infrastructure/b.ts'],
      ['infrastructure/a.test.ts', 'index.ts'],
      ['infrastructure/a.test.ts', 'test-support/database.ts'],
    ])
      assert.equal(violation(file(app, from), file(app, to)), null, from);
    for (const [from, to] of [
      ['domain/a.ts', 'application/b.ts'],
      ['application/a.ts', 'infrastructure/b.ts'],
      ['infrastructure/a.ts', 'api/b.ts'],
      ['infrastructure/a.ts', 'index.ts'],
      ['api/a.ts', 'infrastructure/b.ts'],
      ['web/a.ts', 'infrastructure/b.ts'],
      ['web/a.ts', 'application/b.ts'],
      ['lib/a.ts', 'domain/b.ts'],
    ])
      assert.ok(violation(file(app, from), file(app, to)), `${from} -> ${to}`);
    assert.ok(
      violation(file(app, 'index.ts'), file(`${app}-other`, 'index.ts')),
    );
  }
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
