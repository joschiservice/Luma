import { setTimeout as delay } from 'node:timers/promises';

/** Trusted callers classify work; document text never determines its scheduling priority. */
export type RequestPurpose = 'foreground' | 'incremental' | 'history';

/** Feedback for one request, including refunded points and provider-wide cooldown. */
export interface BudgetFeedback {
  /** Confirms a reservation is still valid after credential refresh, before transport dispatch. */
  beforeSend?(): Promise<void>;
  /** Marks transport dispatch; unused reservations can otherwise be safely returned. */
  dispatched?(): void;
  observe(
    shape: string,
    cost: number,
    available: number,
    restoreRate: number,
    actualCost?: number,
    maximumAvailable?: number,
  ): void | Promise<void>;
  cooldown(milliseconds: number): void | Promise<void>;
}

/** One shop's observed GraphQL budget. Scheduling does not authorize provider effects. */
export interface ReadBudget extends BudgetFeedback {
  run<T>(
    shape: string,
    send: (feedback: BudgetFeedback) => Promise<T>,
    admission?: {
      purpose?: RequestPurpose;
      /** Serializes mutation admission while preserving capacity for fresh precondition reads. */
      mutation?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<T>;
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

        return await send(this);
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
