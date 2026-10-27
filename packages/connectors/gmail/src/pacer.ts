import { setTimeout as delay } from 'node:timers/promises';

import { ConnectorError } from '@luma/connector-core';

/**
 * Gmail quota units per method. Gmail allows 250 units per user per second; see
 * https://developers.google.com/workspace/gmail/api/reference/quota.
 */
export const quotaUnits = {
  'users.getProfile': 1,
  'users.labels.list': 1,
  'users.messages.list': 5,
  'users.messages.get': 5,
  'users.messages.attachments.get': 5,
  'users.threads.get': 10,
  'users.messages.send': 100,
  'users.watch': 100,
  'users.stop': 1,
} as const;

export type GmailMethod = keyof typeof quotaUnits;

/**
 * Admits requests of one mailbox so their quota cost stays below a per-second rate. Admission is
 * serialized and spaced by each request's cost; admitted requests may run concurrently.
 */
export interface QuotaPacer {
  /**
   * Waits until `units` fit the rate, then sends. When admission is further away than
   * `maxAdmissionWaitMs`, for example during a cooldown, nothing is sent and the call fails
   * with `rate_limited` carrying the remaining delay.
   */
  run<T>(units: number, send: () => Promise<T>): Promise<T>;
  /** Admits nothing for at least this long, for example after Gmail throttled the mailbox. */
  cooldown(milliseconds: number): void;
}

/**
 * Default rate: 200 of Gmail's 250 units per second, leaving room for clock differences, other
 * Luma processes and the person's own Gmail clients sharing the same per-user quota.
 */
const defaultUnitsPerSecond = 200;

/**
 * Longest admission wait spent in place. Ordinary pacing waits at most one request's cost
 * (half a second for a send); longer waits come from cooldowns after Gmail throttled. Those are
 * returned to the caller instead, so a send never leaves long after execution's last authority
 * check and a sync run does not hold a worker for the quota window.
 */
export const maxAdmissionWaitMs = 5000;

/** Creates a pacer that spaces request admissions by their quota cost and caps in-place waits. */
export function createQuotaPacer(
  options: {
    unitsPerSecond?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): QuotaPacer {
  const msPerUnit = 1000 / (options.unitsPerSecond ?? defaultUnitsPerSecond);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => delay(ms));
  let notBefore = 0;
  let tail = Promise.resolve();

  return {
    async run(units, send) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        const wait = Math.max(0, notBefore - now());
        if (wait > maxAdmissionWaitMs)
          throw new ConnectorError({
            code: 'rate_limited',
            effect: 'none',
            retry: 'after_delay',
            retryAfterMs: Math.ceil(wait),
          });
        if (wait) await sleep(wait);
        notBefore = Math.max(notBefore, now()) + units * msPerUnit;
      } finally {
        release();
      }

      return send();
    },
    cooldown(milliseconds) {
      notBefore = Math.max(notBefore, now() + milliseconds);
    },
  };
}
