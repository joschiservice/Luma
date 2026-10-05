import { z } from 'zod';

import { ConnectorError, type ConnectorErrorCode } from './index.js';

/**
 * Throws a connector failure with no recorded effect; supplying a delay marks it retryable
 * after that delay.
 */
export function fail(code: ConnectorErrorCode, retryAfterMs?: number): never {
  throw new ConnectorError({
    code,
    effect: 'none',
    retry: retryAfterMs === undefined ? 'never' : 'after_delay',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/**
 * Validates a provider response and throws an invalid-response connector failure when it
 * does not match the schema.
 */
export function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) fail('invalid_response');

  return result.data;
}

/** Returns a nonnegative Retry-After delay in milliseconds, defaulting to one second. */
export function retryAfterMs(value: string | null, now = Date.now()): number {
  const seconds = value === null ? NaN : Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value ?? '') - now;

  return Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : 1000;
}

export interface ReadRetry {
  /** Total attempts for one read, including the first. */
  attempts: number;
  /** Longest advised delay waited in place; longer advice is returned to the caller. */
  maxDelayMs: number;
  sleep(ms: number): Promise<void>;
}

const defaultReadRetry: ReadRetry = {
  attempts: 3,
  maxDelayMs: 2000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Repeats an idempotent provider read after failures that carry retry advice and no effect,
 * waiting the advised delay. Pass only reads: a repeated write could duplicate its effect.
 * Other failures, the last attempt's failure and advice longer than `maxDelayMs` are thrown
 * unchanged, so callers can schedule a later retry.
 */
export async function retryRead<T>(
  read: () => Promise<T>,
  retry: ReadRetry = defaultReadRetry,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const failure = error instanceof ConnectorError ? error.failure : null;
      const delayMs = failure?.retryAfterMs ?? 1000;
      if (
        attempt >= retry.attempts ||
        failure?.retry !== 'after_delay' ||
        failure.effect !== 'none' ||
        delayMs > retry.maxDelayMs
      )
        throw error;
      await retry.sleep(delayMs);
    }
  }
}
