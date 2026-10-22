import { expect, it } from 'vitest';

import { mapLimited, settleLimited } from './concurrency.js';

/** Records the highest number of calls running at once. */
function tracked() {
  let running = 0;
  let peak = 0;

  return {
    peak: () => peak,
    async run<T>(value: T, delayMs = 1) {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      running -= 1;

      return value;
    },
  };
}

it('keeps input order with at most the limit in flight', async () => {
  const calls = tracked();
  const items = Array.from({ length: 10 }, (_, index) => index);

  const results = await mapLimited(items, 3, (item) =>
    calls.run(item * 2, 10 - item),
  );

  expect(results).toEqual(items.map((item) => item * 2));
  expect(calls.peak()).toBe(3);
});

it('rejects with the first failure and starts no further calls', async () => {
  const started: number[] = [];

  const failure = mapLimited([0, 1, 2, 3, 4], 2, async (item) => {
    started.push(item);
    if (item === 1) throw new Error('owner failed');

    return item;
  });

  await expect(failure).rejects.toThrow('owner failed');
  expect(started).toEqual([0, 1, 2]);
});

it('settles every item without exceeding the limit', async () => {
  const calls = tracked();

  const results = await settleLimited([0, 1, 2, 3], 2, async (item) => {
    if (item === 2) throw new Error('unavailable');

    return calls.run(item);
  });

  expect(results.map((result) => result.status)).toEqual([
    'fulfilled',
    'fulfilled',
    'rejected',
    'fulfilled',
  ]);
  expect(calls.peak()).toBeLessThanOrEqual(2);
});

it('rejects a limit below one', async () => {
  await expect(mapLimited([1], 0, async (item) => item)).rejects.toThrow(
    RangeError,
  );
});
