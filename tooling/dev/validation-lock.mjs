import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import lockfile from 'proper-lockfile';

const stale = 30_000;

/**
 * Serializes validation in one checkout. Nested commands inherit the active owner's token;
 * unrelated commands wait, and a crashed owner's heartbeat expires. Release before exiting.
 * @param {string} root checkout directory
 * @param {{ owner?: string, signal?: AbortSignal, onWait?: () => void }} options
 */
export async function acquireValidation(root, { owner, signal, onWait } = {}) {
  const directory = join(root, '.luma');
  await mkdir(directory, { recursive: true });
  const target = join(directory, 'validation');
  const ownerPath = `${target}.owner`;
  if (owner) {
    try {
      const current = await readFile(ownerPath, 'utf8');
      /** @type {unknown} */
      const parsed = current === owner ? JSON.parse(current) : null;
      if (
        parsed &&
        typeof parsed === 'object' &&
        'pid' in parsed &&
        typeof parsed.pid === 'number' &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0
      ) {
        process.kill(parsed.pid, 0);
        if (await lockfile.check(target, { realpath: false, stale }))
          return {
            owner,
            release: async () => {
              // Only the outer command releases the shared lease.
            },
          };
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        !['ENOENT', 'ESRCH'].includes(String(error.code))
      )
        throw error;
    }
  }

  let waiting = false;
  let release;
  for (;;) {
    signal?.throwIfAborted();
    try {
      release = await lockfile.lock(target, {
        realpath: false,
        stale,
        update: 1000,
      });
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ELOCKED'
      )
        throw error;
      if (!waiting) {
        waiting = true;
        onWait?.();
      }
      await setTimeout(100, undefined, { signal });
    }
  }
  const identity = JSON.stringify({ pid: process.pid, token: randomUUID() });
  try {
    await writeFile(ownerPath, identity);
  } catch (error) {
    await release();
    throw error;
  }
  let closing;

  return {
    owner: identity,
    release() {
      return (closing ??= (async () => {
        try {
          await rm(ownerPath, { force: true });
        } finally {
          await release();
        }
      })());
    },
  };
}

/**
 * Reports whether a command runs backend or browser journeys, which start the API, workers,
 * simulators and browsers and compete for the machine's CPU across checkouts.
 * @param {string[]} args pnpm arguments
 */
export function runsJourneys(args) {
  return (
    args.includes('@luma/api') &&
    args.some((arg) =>
      [
        'test:e2e',
        'test:browser',
        'test:e2e:performance',
        'test:browser:performance',
      ].includes(arg),
    )
  );
}

/**
 * Takes one of the machine's journey slots, shared by every checkout of this user. Journeys
 * from other worktrees wait instead of overloading the CPU and timing each other out. The
 * slot count comes from `LUMA_JOURNEY_SLOTS` (default 1). A crashed holder's heartbeat expires.
 * Release before exiting.
 * @param {string} root checkout directory, shown to waiting runs
 * @param {{ directory?: string, slots?: number, signal?: AbortSignal, onWait?: (holders: string[]) => void }} options
 */
export async function acquireJourneySlot(
  root,
  {
    directory = join(tmpdir(), 'luma-journeys'),
    slots = journeySlots(process.env.LUMA_JOURNEY_SLOTS),
    signal,
    onWait,
  } = {},
) {
  await mkdir(directory, { recursive: true });
  let waiting = false;
  for (;;) {
    signal?.throwIfAborted();
    for (let slot = 1; slot <= slots; slot++) {
      const target = join(directory, `slot-${slot}`);
      let release;
      try {
        release = await lockfile.lock(target, {
          realpath: false,
          stale,
          update: 1000,
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ELOCKED'
        )
          throw error;
        continue;
      }
      const ownerPath = `${target}.owner`;
      try {
        await writeFile(ownerPath, root);
      } catch (error) {
        await release();
        throw error;
      }
      let closing;

      return {
        release() {
          return (closing ??= (async () => {
            try {
              await rm(ownerPath, { force: true });
            } finally {
              await release();
            }
          })());
        },
      };
    }
    if (!waiting) {
      waiting = true;
      const holders = [];
      for (let slot = 1; slot <= slots; slot++)
        holders.push(
          await readFile(join(directory, `slot-${slot}.owner`), 'utf8').catch(
            () => 'an unknown checkout',
          ),
        );
      onWait?.(holders);
    }
    await setTimeout(100, undefined, { signal });
  }
}

/**
 * Parses the journey slot count; rejects values that would disable or misconfigure the queue.
 * @param {string | undefined} value
 */
export function journeySlots(value) {
  if (value === undefined || value === '') return 1;
  const slots = Number(value);
  if (!Number.isInteger(slots) || slots < 1)
    throw new Error('LUMA_JOURNEY_SLOTS must be a positive integer');

  return slots;
}
