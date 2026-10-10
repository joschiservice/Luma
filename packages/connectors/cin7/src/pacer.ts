import { setTimeout as delay } from 'node:timers/promises';

/**
 * Admits requests of one Cin7 API application one at a time, at most one per interval.
 * Admission is serialized; admitted requests may still be in flight together.
 */
export interface RequestPacer {
  /** Waits for the next admission slot, then sends. */
  run<T>(send: () => Promise<T>): Promise<T>;
  /** Admits nothing for at least this long, for example after the provider throttled. */
  cooldown(milliseconds: number): void;
  /** Milliseconds until the next request could be admitted. */
  nextDelay(): number;
}

/**
 * Cin7 allows 60 calls per minute per API application. The default interval admits about
 * 55, leaving room for clock differences and requests from another Luma process.
 */
export const defaultIntervalMs = 1100;

/** Creates a pacer that spaces request admissions evenly. */
export function createRequestPacer(
  options: {
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): RequestPacer {
  const intervalMs = options.intervalMs ?? defaultIntervalMs;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => delay(ms));
  let notBefore = 0;
  let tail = Promise.resolve();
  const waitFor = () => Math.max(0, notBefore - now());

  return {
    async run(send) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        const wait = waitFor();
        if (wait) await sleep(wait);
        notBefore = Math.max(notBefore, now() + intervalMs);
      } finally {
        release();
      }

      return send();
    },
    cooldown(milliseconds) {
      notBefore = Math.max(notBefore, now() + milliseconds);
    },
    nextDelay: waitFor,
  };
}
