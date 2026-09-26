import { describe, expect, it } from 'vitest';

import { readConnectionsConfig } from './connections.js';

const key = Buffer.alloc(32, 7).toString('base64');

const env = {
  CONNECTIONS_ACTIVE_KEY_ID: 'current',
  CONNECTIONS_KEYS: JSON.stringify({ current: key, previous: key }),
};

describe('connection configuration', () => {
  it('requires complete keyrings and retains old decryption keys', () => {
    expect(readConnectionsConfig({})).toBeUndefined();
    expect(readConnectionsConfig(env)?.keys.size).toBe(2);
    for (const value of [
      { CONNECTIONS_ACTIVE_KEY_ID: 'current' },
      { ...env, CONNECTIONS_ACTIVE_KEY_ID: 'missing' },
      { ...env, CONNECTIONS_KEYS: 'secret-invalid-json' },
      {
        ...env,
        CONNECTIONS_KEYS: JSON.stringify({
          current: Buffer.alloc(16).toString('base64'),
        }),
      },
    ])
      expect(() => readConnectionsConfig(value)).toThrow(
        'Configure CONNECTIONS',
      );
  });
});
