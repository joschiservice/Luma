import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './process.mjs';
import { freePort, project } from './environment.mjs';

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

test('worktree project names are valid Compose identifiers and ports are available', async () => {
  assert.match(project, /^luma-[a-f0-9]{12}$/);
  const port = await freePort();
  assert.ok(port > 0 && port < 65536);
});
