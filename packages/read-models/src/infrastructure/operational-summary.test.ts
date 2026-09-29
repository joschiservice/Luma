import { makeTenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { expect, it, vi } from 'vitest';

import { createOperationalSummary } from './operational-summary.js';

const tenant = '00000000-0000-4000-8000-000000000001';
const context = makeTenantContext(
  { userId: 'user', sessionId: 'session' },
  {
    id: tenant,
    name: 'Workspace',
    slug: 'workspace',
    status: 'active',
    dataRegion: 'EU',
  },
  { id: 'member', organizationId: tenant, userId: 'user', role: 'owner' },
  'test',
);
it('reads only selected families and rejects unsupported filters before database access', async () => {
  const tx = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
  const transaction = vi.fn();
  const db: TenantDatabase = {
    transaction: async (tenantId, operation, options) => {
      transaction(tenantId, operation, options);

      return operation(tx);
    },
  };
  const coverage = vi.fn().mockResolvedValue([]);
  const cases = vi.fn();
  const procurement = vi.fn();
  const metrics = createOperationalSummary(
    db,
    { cases, procurement, coverage: () => coverage },
    () => new Date('2026-09-28T00:00:00Z'),
  );
  const request = {
    definitionVersion: 2 as const,
    metrics: ['connections.needing_attention'],
  };
  const first = await metrics(context, request);
  expect(first.metrics[0]).toMatchObject({ value: 0, total: 0 });
  expect(cases).not.toHaveBeenCalled();
  expect(procurement).not.toHaveBeenCalled();
  expect(transaction).toHaveBeenCalledWith(tenant, expect.any(Function), {
    readOnlySnapshot: true,
  });
  await expect(
    metrics(context, { ...request, scope: { supplierId: tenant } }),
  ).rejects.toThrow();
  expect(transaction).toHaveBeenCalledTimes(1);
  const next = await metrics(context, {
    ...request,
    snapshot: first.snapshot,
    asOf: first.asOf,
    offset: 1,
  });
  expect(next.snapshot).toBe(first.snapshot);
  coverage.mockResolvedValue([
    {
      id: tenant,
      label: 'New connection',
      status: 'pending',
      freshness: 'unobserved',
      lastObservedAt: null,
    },
  ]);
  await expect(
    metrics(context, {
      ...request,
      snapshot: first.snapshot,
      asOf: first.asOf,
      offset: 1,
    }),
  ).rejects.toThrow('matching records changed');
});
