import { expect, it } from 'vitest';

import { createDatabasePool } from './database-pool.js';

const pool = (workload: 'request' | 'background') =>
  createDatabasePool({
    connectionString: 'postgresql://localhost/unused',
    max: 1,
    workload,
    onError: () => undefined,
  });

it('disables JIT compilation for request reads only', async () => {
  const request = pool('request'),
    background = pool('background');

  expect(request.options.options).toBe('-c jit=off');
  expect(background.options.options).toBeUndefined();

  await Promise.all([request.end(), background.end()]);
});
