import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  acquireJourneySlot,
  acquireValidation,
  journeySlots,
  runsJourneys,
} from './validation-lock.mjs';

async function checkout(t) {
  const root = await mkdtemp(join(tmpdir(), 'luma-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

test('independent validation waits while nested commands share the lease without releasing it', async (t) => {
  const root = await checkout(t);
  const first = await acquireValidation(root);
  t.after(first.release);
  const nested = await acquireValidation(root, { owner: first.owner });
  await nested.release();
  let announced;
  const waiting = new Promise((resolve) => {
    announced = resolve;
  });
  let entered = false;
  const second = acquireValidation(root, { onWait: () => announced() }).then(
    (lease) => {
      entered = true;

      return lease;
    },
  );
  await waiting;
  assert.equal(entered, false);
  assert.equal(
    await readFile(join(root, '.luma/validation.owner'), 'utf8'),
    first.owner,
  );
  await first.release();
  const lease = await second;
  assert.notEqual(lease.owner, first.owner);
  await lease.release();
});

test('a cancelled waiter leaves the current owner and its nested commands intact', async (t) => {
  const root = await checkout(t);
  const first = await acquireValidation(root);
  t.after(first.release);
  const controller = new AbortController();
  const rejected = assert.rejects(
    acquireValidation(root, {
      signal: controller.signal,
      onWait: () => controller.abort(),
    }),
    { name: 'AbortError' },
  );
  await rejected;
  const nested = await acquireValidation(root, { owner: first.owner });
  await nested.release();
  assert.equal(
    await readFile(join(root, '.luma/validation.owner'), 'utf8'),
    first.owner,
  );
});

test('a killed validation owner does not permanently block later runs', async (t) => {
  const root = await checkout(t);
  const url = pathToFileURL(
    join(import.meta.dirname, 'validation-lock.mjs'),
  ).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { acquireValidation } from ${JSON.stringify(url)};
    await acquireValidation(${JSON.stringify(root)});
    process.send('locked');
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  await once(child, 'message');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  // Advance only the dead lease's heartbeat, avoiding a thirty-second test wait.
  const old = new Date(Date.now() - 60_000);
  await utimes(join(root, '.luma/validation.lock'), old, old);
  const lease = await acquireValidation(root);
  await lease.release();
});

test('journeys from another checkout wait for a free slot and name the holder', async (t) => {
  const directory = await checkout(t);
  const first = await acquireJourneySlot('/checkouts/a', { directory });
  t.after(first.release);
  let announced;
  const waiting = new Promise((resolve) => {
    announced = resolve;
  });
  let entered = false;
  const second = acquireJourneySlot('/checkouts/b', {
    directory,
    onWait: (holders) => announced(holders),
  }).then((slot) => {
    entered = true;

    return slot;
  });
  assert.deepEqual(await waiting, ['/checkouts/a']);
  assert.equal(entered, false);
  await first.release();
  const slot = await second;
  assert.equal(
    await readFile(join(directory, 'slot-1.owner'), 'utf8'),
    '/checkouts/b',
  );
  await slot.release();
});

test('more journey slots let that many checkouts run at once', async (t) => {
  const directory = await checkout(t);
  const first = await acquireJourneySlot('/checkouts/a', {
    directory,
    slots: 2,
  });
  t.after(first.release);
  const second = await acquireJourneySlot('/checkouts/b', {
    directory,
    slots: 2,
    onWait: () => assert.fail('a free slot should not wait'),
  });
  await second.release();
});

test('only API journey commands take a journey slot, and slot counts must be positive', () => {
  assert.equal(
    runsJourneys(['--filter', '@luma/api', 'test:e2e', 'e2e/a.e2e.mjs']),
    true,
  );
  assert.equal(runsJourneys(['--filter', '@luma/api', 'test:browser']), true);
  assert.equal(
    runsJourneys(['--filter', '@luma/api', 'test:browser:performance']),
    true,
  );
  assert.equal(
    runsJourneys(['exec', 'turbo', 'run', 'build', '--filter=@luma/api...']),
    false,
  );
  assert.equal(runsJourneys(['test:e2e']), false);
  assert.equal(journeySlots(undefined), 1);
  assert.equal(journeySlots('2'), 2);
  assert.throws(() => journeySlots('0'), /positive integer/);
  assert.throws(() => journeySlots('two'), /positive integer/);
});
