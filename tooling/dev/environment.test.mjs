import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { codeRuntimeDirectory } from './environment.mjs';

test('local processes use the installed Code Step runtime unless apps/api/.env overrides it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = join(directory, 'code-runtime');

  assert.equal(await codeRuntimeDirectory({}, installed), null);
  await mkdir(installed);
  assert.equal(await codeRuntimeDirectory({}, installed), null);
  await writeFile(join(installed, 'manifest.json'), '{}');
  assert.equal(await codeRuntimeDirectory({}, installed), installed);
  assert.equal(
    await codeRuntimeDirectory(
      { LUMA_CODE_RUNTIME_DIR: '/opt/runtime' },
      installed,
    ),
    '/opt/runtime',
  );
});
