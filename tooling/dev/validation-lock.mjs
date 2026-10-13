import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
