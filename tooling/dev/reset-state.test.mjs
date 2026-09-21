import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { archiveDatabaseState } from './reset-state.mjs';

test('database resets archive stale manifests and simulator data but preserve local settings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-reset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'simulator'));
  const files = {
    'pilot.json': '{"organizationId":"old-pilot"}',
    'simulator/pilot.json': '{"organizationId":"old-simulator"}',
    'simulator/runs.sqlite': 'provider state',
    'simulator/runs.sqlite-wal': 'pending WAL',
    'simulator/transport.json': 'old bindings',
  };
  for (const [name, value] of Object.entries(files))
    await writeFile(join(directory, name), value);
  await writeFile(join(directory, 'state.json'), 'local settings');

  const backup = await archiveDatabaseState(directory);

  for (const [name, value] of Object.entries(files)) {
    assert.equal(await readFile(join(backup, name), 'utf8'), value);
    await assert.rejects(readFile(join(directory, name)), { code: 'ENOENT' });
  }
  assert.equal(
    await readFile(join(directory, 'state.json'), 'utf8'),
    'local settings',
  );
  assert.equal(await archiveDatabaseState(directory), null);
  assert.equal((await readdir(join(directory, 'backups'))).length, 1);
});

test('a simulator-only checkout can be archived and a clean checkout needs no backup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-reset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await archiveDatabaseState(directory), null);
  assert.deepEqual(await readdir(directory), []);
  await mkdir(join(directory, 'simulator'));
  await writeFile(join(directory, 'simulator', 'pilot.json'), 'old manifest');
  const backup = await archiveDatabaseState(directory);
  assert.equal(
    await readFile(join(backup, 'simulator', 'pilot.json'), 'utf8'),
    'old manifest',
  );
});
