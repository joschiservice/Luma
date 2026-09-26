import { expect, it } from 'vitest';

import { readJtlEndpoints } from './config.js';

it('requires exact tenant destinations and IP pins', () => {
  const endpoint = {
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
    baseUrl: 'https://erp.example.test/api/company/',
    addresses: ['10.0.0.5'],
  };
  const config = (value: unknown) =>
    readJtlEndpoints({
      JTL_ALLOWED_ENDPOINTS: JSON.stringify([value]),
    });
  expect(config(endpoint)).toEqual([endpoint]);
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
