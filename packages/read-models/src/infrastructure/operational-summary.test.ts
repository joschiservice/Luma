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
});

it('pages cohorts after the last record read, unaffected by records joining or leaving', async () => {
  const tx = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
  const db: TenantDatabase = {
    transaction: async (_tenantId, operation) => operation(tx),
  };
  const connection = (id: number, label: string) => ({
    id: `00000000-0000-4000-8000-00000000000${id}`,
    label,
    status: 'pending' as const,
    freshness: 'unobserved' as const,
    lastObservedAt: null,
  });
  const coverage = vi
    .fn()
    .mockResolvedValue([
      connection(3, 'Cologne'),
      connection(1, 'Aachen'),
      connection(2, 'Berlin'),
    ]);
  const metrics = createOperationalSummary(
    db,
    { cases: vi.fn(), procurement: vi.fn(), coverage: () => coverage },
    () => new Date('2026-09-28T00:00:00Z'),
  );
  const request = {
    definitionVersion: 2 as const,
    metrics: ['connections.needing_attention'],
    limit: 1,
  };
  const labels = (read: Awaited<ReturnType<typeof metrics>>) =>
    read.metrics[0]!.items.map((item) => 'label' in item && item.label);

  const first = await metrics(context, request);
  expect(labels(first)).toEqual(['Aachen']);
  expect(first.metrics[0]).toMatchObject({ offset: 0, observedCount: 3 });
  const cursor = first.metrics[0]!.nextCursor!;

  // A record that sorts earlier doesn't shift the next page.
  coverage.mockResolvedValue([
    connection(4, 'Aa'),
    connection(1, 'Aachen'),
    connection(2, 'Berlin'),
    connection(3, 'Cologne'),
  ]);
  const second = await metrics(context, { ...request, cursor });
  expect(labels(second)).toEqual(['Berlin']);
  expect(second.metrics[0]).toMatchObject({ offset: 1, observedCount: 4 });

  // The last record read can leave the cohort; the page after it still follows.
  coverage.mockResolvedValue([
    connection(1, 'Aachen'),
    connection(3, 'Cologne'),
  ]);
  const third = await metrics(context, {
    ...request,
    cursor: second.metrics[0]!.nextCursor!,
  });
  expect(labels(third)).toEqual(['Cologne']);
  expect(third.metrics[0]!.nextCursor).toBeNull();

  await expect(
    metrics(context, { ...request, cursor: 'not-a-cursor' }),
  ).rejects.toMatchObject({ statusCode: 422 });
  await expect(
    metrics(context, {
      ...request,
      metrics: ['cases.active'],
      cursor,
    }),
  ).rejects.toMatchObject({ statusCode: 422 });
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
