import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { expect, it, vi } from 'vitest';

import { createOperationalSummary } from './operational-summary.js';

const tenant = '00000000-0000-4000-8000-000000000001';
const organization = {
  id: tenant,
  name: 'Workspace',
  slug: 'workspace',
  status: 'active' as const,
  dataRegion: 'EU' as const,
};
const member = { id: 'member', organizationId: tenant, userId: 'user' };
const context = makeTenantContext(
  { userId: 'user', sessionId: 'session' },
  organization,
  builtInMembership(member, 'owner'),
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

it('withholds metric families the reader cannot read without asking their owners', async () => {
  const role = {
    id: 'role',
    key: 'custom' as const,
    name: 'Connections only',
    builtIn: false,
    revision: 1,
  };
  const reader = makeTenantContext(
    { userId: 'user', sessionId: 'session' },
    organization,
    { ...member, role, permissions: PermissionSet.forRole(role, []) },
    'test',
  );
  const tx = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
  const db: TenantDatabase = {
    transaction: async (_tenantId, operation) => operation(tx),
  };
  const cases = vi.fn();
  const procurement = vi.fn();
  const metrics = createOperationalSummary(
    db,
    { cases, procurement, coverage: () => vi.fn().mockResolvedValue([]) },
    () => new Date('2026-09-28T00:00:00Z'),
  );

  const result = await metrics(reader, {
    definitionVersion: 2,
    metrics: [
      'cases.attention',
      'connections.needing_attention',
      'inventory.below_minimum',
    ],
  });

  expect(result.hidden).toEqual(['cases.attention', 'inventory.below_minimum']);
  expect(result.metrics.map((metric) => metric.definition.id)).toEqual([
    'cases.attention',
    'connections.needing_attention',
    'inventory.below_minimum',
  ]);
  expect(result.metrics[0]).toMatchObject({
    value: null,
    coverage: 'unavailable',
    items: [],
  });
  expect(cases).not.toHaveBeenCalled();
  expect(procurement).not.toHaveBeenCalled();
});
