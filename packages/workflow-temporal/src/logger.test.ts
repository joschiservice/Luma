import { describe, expect, it } from 'vitest';

import { formatLogEntry } from './logger.js';

describe('formatLogEntry', () => {
  it('writes one JSON line without database error details', () => {
    const error = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      detail: 'Key (email)=(jane@example.com) already exists.',
    });
    const line = formatLogEntry({
      level: 'ERROR',
      message: 'Activity failed',
      timestampNanos: 1_700_000_000_000_000_000n,
      meta: { activityType: 'read', attempt: 2n, error },
    });

    expect(line).not.toContain('jane@example.com');
    expect(JSON.parse(line)).toMatchObject({
      time: '2023-11-14T22:13:20.000Z',
      level: 'ERROR',
      message: 'Activity failed',
      meta: {
        activityType: 'read',
        attempt: '2',
        error: { type: 'Error', message: 'duplicate key value', code: '23505' },
      },
    });
  });

  it('drops metadata that cannot be serialized', () => {
    const meta: Record<string, unknown> = {};
    meta.self = meta;

    expect(
      JSON.parse(
        formatLogEntry({
          level: 'WARN',
          message: 'Circular',
          timestampNanos: 0n,
          meta,
        }),
      ),
    ).toEqual({
      time: '1970-01-01T00:00:00.000Z',
      level: 'WARN',
      message: 'Circular',
    });
  });
});
