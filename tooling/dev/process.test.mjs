import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { freePort, project } from './environment.mjs';
import { run } from './process.mjs';

test('commands preserve arguments without shell expansion', async () => {
  const value = 'literal $(echo secret) `whoami` with spaces';
  assert.equal(
    await run(process.execPath, ['-e', 'console.log(process.argv[1])', value], {
      capture: true,
    }),
    value,
  );
});

test('failed child commands retain their exit code', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', 'process.exit(7)'], { capture: true }),
    (error) => error.exitCode === 7,
  );
});

test('file logging preserves both outputs and the failure exit code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-process-log-'));
  const path = join(directory, 'step.log');
  const log = await open(path, 'w');
  try {
    await assert.rejects(
      run(
        process.execPath,
        ['-e', 'console.log("out"); console.error("err"); process.exit(7)'],
        { logFd: log.fd },
      ),
      (error) => error.exitCode === 7,
    );
    const output = await readFile(path, 'utf8');
    assert.match(output, /out/);
    assert.match(output, /err/);
  } finally {
    await log.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('worktree project names are valid Compose identifiers and ports are available', async () => {
  assert.match(project, /^luma-[a-f0-9]{12}$/);
  const port = await freePort();
  assert.ok(port > 0 && port < 65536);
});

test('connection keys survive restarts and existing malformed keys are not replaced', async () => {
  const { mkdtemp, readFile, stat, writeFile, rm } =
    await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { connectionKey } = await import('./environment.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'luma-key-'));
  const path = join(directory, 'key');
  try {
    const first = await connectionKey(path);
    assert.equal(Buffer.from(first, 'base64').length, 32);
    assert.equal(await connectionKey(path), first);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writeFile(path, 'broken');
    await assert.rejects(connectionKey(path), /Restore/);
    assert.equal(await readFile(path, 'utf8'), 'broken');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
