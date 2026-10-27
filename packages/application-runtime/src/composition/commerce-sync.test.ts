import { describe, expect, it } from 'vitest';

import { runLoops } from './commerce-sync.js';

/** A loop that runs until shut down, or rejects at once with `failure`. */
function loop(failure?: Error) {
  let stop = () => undefined as void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const state = { finished: false };

  return {
    state,
    run: async () => {
      if (failure) throw failure;
      await stopped;
      state.finished = true;
    },
    shutdown: () => stop(),
  };
}

describe('runLoops', () => {
  it('stops and awaits every loop when one rejects, then rethrows its failure', async () => {
    const failure = new Error('Loop failed');
    const healthy = [loop(), loop()];

    await expect(
      runLoops([healthy[0]!, loop(failure), healthy[1]!]),
    ).rejects.toBe(failure);
    expect(healthy.map((item) => item.state.finished)).toEqual([true, true]);
  });
});
