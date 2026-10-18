import { describe, expect, it } from 'vitest';

import { readCommerceSyncConfig } from './sync.js';

const env = {
  WORKFLOW_DATABASE_URL: 'postgresql://worker:synthetic@localhost/test',
  CONNECTIONS_ACTIVE_KEY_ID: 'test',
  CONNECTIONS_KEYS: JSON.stringify({
    test: Buffer.alloc(32, 7).toString('base64'),
  }),
};

describe('commerce sync configuration', () => {
  it('bounds workspace and connection concurrency independently', () => {
    expect(readCommerceSyncConfig(env)).toMatchObject({
      concurrency: 4,
      workspaceConcurrency: 4,
      connectionConcurrency: 2,
    });
    expect(
      readCommerceSyncConfig({
        ...env,
        COMMERCE_SYNC_WORKSPACE_CONCURRENCY: '8',
        COMMERCE_SYNC_CONNECTION_CONCURRENCY: '2',
      }),
    ).toMatchObject({ workspaceConcurrency: 8, connectionConcurrency: 2 });
    for (const [key, invalid] of [
      ['COMMERCE_SYNC_WORKSPACE_CONCURRENCY', '9'],
      ['COMMERCE_SYNC_CONNECTION_CONCURRENCY', '5'],
      ['COMMERCE_SYNC_CONNECTION_CONCURRENCY', '0'],
      ['COMMERCE_SYNC_WORKSPACE_CONCURRENCY', '1.5'],
    ])
      expect(() => readCommerceSyncConfig({ ...env, [key!]: invalid })).toThrow(
        key!,
      );
  });

  it('reads mailbox retention and polling with bounds', () => {
    expect(readCommerceSyncConfig(env).messaging).toEqual({
      retentionDays: 365,
      pollMs: 120_000,
    });
    expect(
      readCommerceSyncConfig({
        ...env,
        MESSAGING_RETENTION_DAYS: '90',
        MESSAGING_POLL_SECONDS: '60',
      }).messaging,
    ).toEqual({ retentionDays: 90, pollMs: 60_000 });
    for (const [key, invalid] of [
      ['MESSAGING_RETENTION_DAYS', '7'],
      ['MESSAGING_POLL_SECONDS', '5'],
    ])
      expect(() => readCommerceSyncConfig({ ...env, [key!]: invalid })).toThrow(
        key!,
      );
  });

  it('bounds how long a closed workspace keeps its data', () => {
    expect(readCommerceSyncConfig(env).closureRetentionDays).toBe(90);
    expect(
      readCommerceSyncConfig({
        ...env,
        WORKSPACE_CLOSURE_RETENTION_DAYS: '365',
      }).closureRetentionDays,
    ).toBe(365);
    for (const invalid of ['29', '3651', '90.5'])
      expect(() =>
        readCommerceSyncConfig({
          ...env,
          WORKSPACE_CLOSURE_RETENTION_DAYS: invalid,
        }),
      ).toThrow('WORKSPACE_CLOSURE_RETENTION_DAYS');
  });

  it('keeps audit entries at least as long as the closure window', () => {
    expect(readCommerceSyncConfig(env).auditRetentionDays).toBe(365);
    expect(
      readCommerceSyncConfig({ ...env, AUDIT_RETENTION_DAYS: '2190' })
        .auditRetentionDays,
    ).toBe(2190);
    for (const invalid of ['89', '3651', '365.5'])
      expect(() =>
        readCommerceSyncConfig({ ...env, AUDIT_RETENTION_DAYS: invalid }),
      ).toThrow('AUDIT_RETENTION_DAYS');
  });
});
