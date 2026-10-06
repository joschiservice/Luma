import { setTimeout as delay } from 'node:timers/promises';

/** One shop's observed GraphQL budget. Shared clients serialize request admission. */
export interface ReadBudget {
  run<T>(shape: string, send: () => Promise<T>): Promise<T>;
  observe(
    shape: string,
    cost: number,
    available: number,
    restoreRate: number,
  ): void;
  cooldown(milliseconds: number): void;
  nextDelay(): number;
}

/** Uses Shopify's refunded balance and restore rate; unknown query shapes reserve 1,000 points. */
export function createReadBudget(
  options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): ReadBudget {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => delay(ms));
  let balance: { available: number; restoreRate: number; at: number } | null =
    null;
  let notBefore = 0;
  let tail = Promise.resolve();
  const costs = new Map<string, number>();
  const waitFor = (cost: number) =>
    Math.max(
      0,
      notBefore - now(),
      balance
        ? Math.ceil(
            ((cost -
              balance.available -
              ((now() - balance.at) * balance.restoreRate) / 1000) /
              balance.restoreRate) *
              1000,
          )
        : 0,
    );

  return {
    async run(shape, send) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const wait = waitFor(costs.get(shape) ?? 1000);
        if (wait) await sleep(wait);

        return await send();
      } finally {
        release();
      }
    },
    observe(shape, cost, available, restoreRate) {
      costs.set(shape, cost);
      balance = { available, restoreRate, at: now() };
    },
    cooldown(milliseconds) {
      notBefore = Math.max(notBefore, now() + milliseconds);
    },
    nextDelay: () => waitFor(Math.max(1, ...costs.values())),
  };
}
