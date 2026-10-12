import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { freePort, project } from './environment.mjs';
import { run, runTogether } from './process.mjs';

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

test('commands run together stop when one exits and report its failure', async () => {
  const started = Date.now();
  await assert.rejects(
    runTogether([
      [
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { capture: true },
      ],
      [process.execPath, ['-e', 'process.exit(3)'], { capture: true }],
    ]),
    (error) => error.exitCode === 3,
  );
  assert.ok(Date.now() - started < 5_000);
});

test('children do not outlive the process that started them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-process-orphan-'));
  const path = join(directory, 'pid');
  const launcher = `
    import { run } from ${JSON.stringify(new URL('./process.mjs', import.meta.url).href)};
    import { existsSync } from 'node:fs';
    void run(process.execPath, ['-e', ${JSON.stringify(
      `require('node:fs').writeFileSync(${JSON.stringify(path)}, String(process.pid)); setInterval(() => {}, 1000)`,
    )}]).catch(() => {});
    const ready = setInterval(() => existsSync(${JSON.stringify(path)}) && process.exit(0), 20);
  `;
  try {
    // No pipes: an orphaned child must not be able to keep this test waiting.
    const parent = spawn(
      process.execPath,
      ['--input-type=module', '-e', launcher],
      { stdio: 'ignore' },
    );
    await once(parent, 'exit');
    const pid = Number(await readFile(path, 'utf8'));
    const alive = () => {
      try {
        process.kill(pid, 0);

        return true;
      } catch {
        return false;
      }
    };
    for (let attempt = 0; alive() && attempt < 50; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const survived = alive();
    if (survived) process.kill(pid, 'SIGKILL');
    assert.equal(survived, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
