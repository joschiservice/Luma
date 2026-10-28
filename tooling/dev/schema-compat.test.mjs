import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { migrationFiles } from './migration-contract.mjs';
import { copyMigrations, parseOptions } from './schema-compat.mjs';

/** Creates a checkout-shaped directory holding the given files. */
function checkout(/** @type {Record<string, string>} */ files) {
  const directory = mkdtempSync(join(tmpdir(), 'schema-compat-test-'));
  mkdirSync(join(directory, 'packages/apps'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), content);
  }

  return directory;
}

test('copies new and changed core and app migrations into the base checkout', (t) => {
  const source = checkout({
    'packages/application-runtime/migrations/0001_a.sql': 'a',
    'packages/application-runtime/migrations/0002_b.sql': 'b2',
    'packages/application-runtime/migrations/README.md': 'not a migration',
    'packages/apps/jtl/migrations/0001_j.sql': 'j',
    'packages/apps/new-app/migrations/0001_n.sql': 'n',
    'packages/apps/new-app/src/index.ts': 'export {};',
  });
  const target = checkout({
    'packages/application-runtime/migrations/0001_a.sql': 'a',
    'packages/application-runtime/migrations/0002_b.sql': 'b',
    'packages/apps/jtl/migrations/0001_j.sql': 'j',
    'packages/apps/jtl/migrations/0000_only_base.sql': 'kept',
  });
  t.after(() => {
    rmSync(source, { recursive: true });
    rmSync(target, { recursive: true });
  });

  assert.deepEqual(copyMigrations(source, target), [
    'packages/application-runtime/migrations/0002_b.sql',
    'packages/apps/new-app/migrations/0001_n.sql',
  ]);
  assert.equal(
    readFileSync(
      join(target, 'packages/application-runtime/migrations/0002_b.sql'),
      'utf8',
    ),
    'b2',
  );
  assert.deepEqual(migrationFiles(target), [
    'packages/application-runtime/migrations/0001_a.sql',
    'packages/application-runtime/migrations/0002_b.sql',
    'packages/apps/jtl/migrations/0000_only_base.sql',
    'packages/apps/jtl/migrations/0001_j.sql',
    'packages/apps/new-app/migrations/0001_n.sql',
  ]);
  assert.deepEqual(copyMigrations(source, target), []);
});

test('parses options and forwards journey filters', () => {
  assert.deepEqual(
    parseOptions([
      '--base',
      'origin/dev',
      '--directory',
      '../base',
      '--',
      'orders.e2e.mjs',
    ]),
    {
      base: 'origin/dev',
      directory: '../base',
      force: false,
      dryRun: false,
      help: false,
      filters: ['orders.e2e.mjs'],
    },
  );
  assert.equal(parseOptions(['--dry-run']).dryRun, true);
  assert.throws(() => parseOptions(['--directory']), /needs a value/);
  assert.throws(() => parseOptions(['--shard=1/2']), /Unknown argument/);
});
