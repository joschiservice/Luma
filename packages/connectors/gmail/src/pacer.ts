import { setTimeout as delay } from 'node:timers/promises';

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
  /** Waits until `units` fit the rate, then sends. */
  run<T>(units: number, send: () => Promise<T>): Promise<T>;
  /** Admits nothing for at least this long, for example after Gmail throttled the mailbox. */
  cooldown(milliseconds: number): void;
}

/**
 * Default rate: 200 of Gmail's 250 units per second, leaving room for clock differences, other
 * Luma processes and the person's own Gmail clients sharing the same per-user quota.
 */
export const defaultUnitsPerSecond = 200;

/** Creates a pacer that spaces request admissions by their quota cost. */
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
