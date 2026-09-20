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
