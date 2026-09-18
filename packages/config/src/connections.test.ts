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
  it('requires exact tenant destinations and IP pins', () => {
    const endpoint = {
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      baseUrl: 'https://erp.example.test/api/company/',
      addresses: ['10.0.0.5'],
    };
    const config = (value: unknown) =>
      readConnectionsConfig({
        ...env,
        JTL_ALLOWED_ENDPOINTS: JSON.stringify([value]),
      });
    expect(config(endpoint)?.jtlEndpoints).toEqual([endpoint]);
    for (const change of [
      { addresses: ['erp.example.test'] },
      { addresses: [] },
      { tenantId: 'bad' },
      { baseUrl: 'http://erp.example.test/' },
      { baseUrl: 'https://user:password@erp.example.test/' },
      { baseUrl: 'https://erp.example.test/api' },
      { baseUrl: 'https://erp.example.test/?redirect=1' },
      { baseUrl: 'https://127.0.0.1/' },
    ])
      expect(() => config({ ...endpoint, ...change })).toThrow(
        'JTL_ALLOWED_ENDPOINTS',
      );
  });
});
