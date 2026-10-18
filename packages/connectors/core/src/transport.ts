import { z } from 'zod';

import { ConnectorError, type ConnectorErrorCode } from './index.js';

/**
 * Throws a connector failure with no recorded effect; supplying a delay marks it retryable
 * after that delay. A provider code is kept only when it is a plain identifier.
 */
export function fail(
  code: ConnectorErrorCode,
  retryAfterMs?: number,
  providerCode?: string,
): never {
  throw new ConnectorError({
    code,
    ...(providerCode && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(providerCode)
      ? { providerCode }
      : {}),
    effect: 'none',
    retry: retryAfterMs === undefined ? 'never' : 'after_delay',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/**
 * Validates a provider response and throws an invalid-response connector failure when it
 * does not match the schema.
 */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
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
  /** Waits `ms`; rejects with the signal's reason when `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Uniform value in [0, 1) that spreads waits; defaults to `Math.random`. */
  random?: () => number;
}

/** Waits `ms`, rejecting with the abort reason and clearing the timer once `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);

      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

const defaultReadRetry: ReadRetry = {
  attempts: 3,
  maxDelayMs: 2000,
  sleep: abortableSleep,
};

/**
 * Lengthens an advised delay by up to half its value so clients that failed together do not
 * retry together. The advice is a lower bound and is never shortened; the result stays
 * within `maxDelayMs`.
 */
export function jitteredDelayMs(
  advisedMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
) {
  return Math.min(
    maxDelayMs,
    advisedMs + Math.floor(random() * (advisedMs / 2)),
  );
}

/**
 * Repeats an idempotent provider read after failures that carry retry advice and no effect,
 * waiting the advised delay plus jitter. Pass only reads: a repeated write could duplicate
 * its effect. Other failures, the last attempt's failure and advice longer than `maxDelayMs`
 * are thrown unchanged, so callers can schedule a later retry. Aborting `signal` ends a wait
 * at once and throws the last read failure without another attempt; `read` itself must honor
 * the signal for its own request.
 */
export async function retryRead<T>(
  read: () => Promise<T>,
  retry: ReadRetry = defaultReadRetry,
  signal?: AbortSignal,
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
        failure.providerCode === 'ADMISSION_DEFERRED' ||
        delayMs > retry.maxDelayMs ||
        signal?.aborted
      )
        throw error;
      // Callers handle provider failures, not abort reasons.
      await retry
        .sleep(jitteredDelayMs(delayMs, retry.maxDelayMs, retry.random), signal)
        .catch(() => {
          throw error;
        });
    }
  }
}

/** Encodes and decodes an opaque page cursor as base64url JSON. */
export interface CursorCodec<T> {
  /** Serializes the value with `JSON.stringify`, so its key order is the wire order. */
  encode(value: T): string;
  /** Returns the validated value, or throws an `invalid_input` connector failure. */
  decode(cursor: string): T;
}

/**
 * Creates a cursor codec for provider page cursors. Decoding rejects text that is not JSON
 * matching the schema; `canonical` also rejects base64url text that does not re-encode to
 * itself. Callers still compare any request binding the cursor carries.
 */
export function createCursorCodec<T>(
  schema: z.ZodType<T>,
  options: { canonical?: boolean } = {},
): CursorCodec<T> {
  return {
    encode: (value) => Buffer.from(JSON.stringify(value)).toString('base64url'),
    decode(cursor) {
      try {
        const bytes = Buffer.from(cursor, 'base64url');
        if (options.canonical && bytes.toString('base64url') !== cursor)
          fail('invalid_input');

        return schema.parse(JSON.parse(bytes.toString('utf8')));
      } catch {
        fail('invalid_input');
      }
    },
  };
}

/** Raw provider evidence attached to recorded observations while retention is enabled. */
export interface CapturedPayloads {
  raw?: { payloads: unknown[]; expiresAt: string };
}

/**
 * Collects validated provider payloads for one capability call. Values are parsed before
 * capture, so unexpected fields and provider errors never enter evidence. Nothing is kept
 * when `retentionMs` is undefined.
 */
export function createPayloadCapture(
  retentionMs: number | undefined,
  now: () => Date,
) {
  const payloads: unknown[] = [];

  return {
    /** Parses a provider value, failing with `invalid_response`, and retains the result. */
    capture<T>(schema: z.ZodType<T>, value: unknown): T {
      const result = parse(schema, value);
      if (retentionMs !== undefined) payloads.push(result);

      return result;
    },
    /** Returns the retained payloads with their expiry, or nothing without retention. */
    raw(): CapturedPayloads {
      return retentionMs === undefined
        ? {}
        : {
            raw: {
              payloads,
              expiresAt: new Date(now().getTime() + retentionMs).toISOString(),
            },
          };
    },
  };
}
