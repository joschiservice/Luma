import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ConnectorError } from './index.js';
import { fail, parse, retryAfterMs, retryRead } from './transport.js';

describe('connector transport helpers', () => {
  it.each([
    ['2', 2000],
    ['0.0011', 2],
    ['0', 0],
    ['Sun, 20 Sep 2026 12:00:02 GMT', 2000],
    ['Sun, 20 Sep 2026 11:59:59 GMT', 1000],
    ['invalid', 1000],
    ['-1', 1000],
    [null, 1000],
  ])('normalizes Retry-After %s to %i milliseconds', (value, expected) => {
    expect(retryAfterMs(value, Date.parse('2026-09-20T12:00:00Z'))).toBe(
      expected,
    );
  });

  it('preserves schema transformations and hides invalid response details', () => {
    expect(parse(z.string().transform(Number), '42')).toBe(42);
    expect(() => parse(z.number(), 'provider-secret')).toThrow(ConnectorError);
    try {
      parse(z.number(), 'provider-secret');
    } catch (error) {
      expect(error).toMatchObject({
        failure: { code: 'invalid_response', effect: 'none', retry: 'never' },
      });
      expect(String(error)).not.toContain('provider-secret');
    }
  });

  it('marks a supplied retry delay without claiming an effect', () => {
    expect(() => fail('rate_limited', 2500)).toThrow(ConnectorError);
    try {
      fail('rate_limited', 2500);
    } catch (error) {
      expect(error).toMatchObject({
        failure: {
          code: 'rate_limited',
          effect: 'none',
          retry: 'after_delay',
          retryAfterMs: 2500,
        },
      });
    }
  });

  it('repeats reads after advised failures and returns the first success', async () => {
    const sleep = vi.fn(async () => undefined);
    const read = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(async () => fail('transient', 1000))
      .mockImplementationOnce(async () => fail('rate_limited', 2000))
      .mockResolvedValue('page');

    await expect(
      retryRead(read, { attempts: 3, maxDelayMs: 2000, sleep }),
    ).resolves.toBe('page');
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it.each([
    ['without retry advice', () => fail('not_found')],
    ['with longer advice', () => fail('rate_limited', 30_000)],
    [
      'with an uncertain effect',
      () => {
        throw new ConnectorError({
          code: 'transient',
          effect: 'unknown',
          retry: 'after_delay',
          retryAfterMs: 10,
        });
      },
    ],
    [
      'that are not connector failures',
      () => {
        throw new Error('bug');
      },
    ],
  ])('throws failures %s at once', async (_name, failure) => {
    const read = vi.fn(async () => failure());
    const sleep = vi.fn(async () => undefined);

    await expect(
      retryRead(read, { attempts: 3, maxDelayMs: 2000, sleep }),
    ).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws the last failure after the final attempt', async () => {
    const read = vi.fn(async () => fail('timeout', 10));

    await expect(
      retryRead(read, { attempts: 3, maxDelayMs: 2000, sleep: async () => {} }),
    ).rejects.toMatchObject({ failure: { code: 'timeout' } });
    expect(read).toHaveBeenCalledTimes(3);
  });
});
