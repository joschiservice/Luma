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
});
