import { setTimeout as delay } from 'node:timers/promises';

import { ConnectorError } from '@luma/connector-core';

/**
 * Admits requests of one Cin7 API application one at a time, at most one per interval.
 * Admission is serialized; admitted requests may still be in flight together.
 */
export interface RequestPacer {
  /**
   * Waits for the next admission slot, then sends. When the slot is further away than
   * `maxAdmissionWaitMs`, for example during a cooldown, nothing is sent and the call fails
   * with `rate_limited` carrying the remaining delay.
   */
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
const defaultIntervalMs = 1100;

/**
 * Longest admission wait spent in place. Ordinary pacing waits at most one interval; longer
 * waits come from cooldowns after Cin7 throttled, which last up to a minute. Those are returned
 * to the caller instead, so a sync run does not hold a worker for the throttle window.
 */
export const maxAdmissionWaitMs = 5000;

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
        if (wait > maxAdmissionWaitMs)
          throw new ConnectorError({
            code: 'rate_limited',
            effect: 'none',
            retry: 'after_delay',
            retryAfterMs: Math.ceil(wait),
          });
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
