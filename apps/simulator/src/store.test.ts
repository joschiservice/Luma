import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { openStore } from './store.js';

test('timed transactions preserve results and roll back failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-store-'));
  const operations: string[] = [];
  const store = await openStore(
    join(directory, 'runs.sqlite'),
    (name, work) => {
      operations.push(name);

      return work();
    },
  );
  try {
    expect(await store.transact(() => 'result')).toBe('result');
    await expect(
      store.transact(() => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(await store.transact((runs) => Object.keys(runs))).toEqual([]);
    expect(operations).toEqual(
      expect.arrayContaining([
        'simulator.transaction',
        'sqlite.BEGIN',
        'sqlite.SELECT',
        'simulator.decode',
        'simulator.encode',
        'sqlite.COMMIT',
        'sqlite.ROLLBACK',
      ]),
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
