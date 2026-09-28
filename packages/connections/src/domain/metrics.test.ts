import { expect, it } from 'vitest';

import type { ConnectionCoverage } from './coverage.js';
import { summarizeConnectionMetrics } from './metrics.js';

it('counts each problematic installation once and excludes deliberate disconnections', () => {
  const connection: ConnectionCoverage = {
    id: 'id',
    label: 'Store',
    status: 'active',
    freshness: 'fresh',
    lastObservedAt: null,
  };
  expect(summarizeConnectionMetrics([connection])[0]?.value).toBe(0);
  for (const status of ['pending', 'degraded', 'revoked'] as const)
    expect(
      summarizeConnectionMetrics([
        { ...connection, status, freshness: 'unobserved' },
      ])[0],
    ).toMatchObject({ value: 1, items: [{ reasons: [status, 'unobserved'] }] });
  for (const freshness of ['stale', 'unobserved'] as const)
    expect(
      summarizeConnectionMetrics([{ ...connection, freshness }])[0]?.value,
    ).toBe(1);
  expect(
    summarizeConnectionMetrics([
      { ...connection, status: 'disconnected', freshness: 'stale' },
    ])[0],
  ).toMatchObject({ value: 0, population: 0 });
});
