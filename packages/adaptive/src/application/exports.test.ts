import type { TenantContext } from '@luma/identity';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it } from 'vitest';

import { exportRowLimit } from '../domain/exports.js';
import type { AdaptiveViewQuery } from '../domain/views.js';
import { createViewExports, type ViewExportRecord } from './exports.js';

function context(
  role: 'owner' | 'member' = 'owner',
  supportView = false,
): TenantContext {
  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  return makeTenantContext(
    { userId, sessionId: crypto.randomUUID() },
    {
      id: tenantId,
      name: 'Exports',
      slug: 'exports',
      dataRegion: 'EU',
      status: 'active',
    },
    builtInMembership(
      { id: crypto.randomUUID(), organizationId: tenantId, userId },
      role,
    ),
    crypto.randomUUID(),
    supportView
      ? {
          id: crypto.randomUUID(),
          mode: 'consent',
          expiresAt: '2099-01-01T00:00:00Z',
        }
      : undefined,
  );
}

const query: AdaptiveViewQuery = {
  version: 2,
  domain: 'orders',
  state: {
    segment: null,
    where: {
      match: 'all',
      conditions: [{ field: 'status', op: 'any_of', value: ['open'] }],
    },
    sort: null,
    group: null,
    layout: 'table',
    density: 'comfortable',
    columns: [{ id: 'number' }, { id: 'total' }],
    properties: [],
    preview: false,
  },
  metrics: [],
  charts: [],
  actions: [],
};

function fixture(total: number) {
  const records: ViewExportRecord[] = [];
  const service = createViewExports({
    preview: async (_context, _query, cursor) => {
      const start = cursor ? Number(cursor) : 0;
      const end = Math.min(total, start + 100);

      return {
        items: Array.from({ length: end - start }, (_, index) => ({
          id: String(start + index),
          number: `#${start + index}`,
          total: { amount: '1.00', currency: 'EUR' },
        })),
        nextCursor: end < total ? String(end) : null,
        asOf: '2026-10-13T00:00:00Z',
        totalCount: null,
        warnings: [],
        availableColumns: ['number', 'total'],
        groups: [],
        chartSeries: [],
        aggregates: [],
      };
    },
    refreshContext: async (value) => value,
    record: async (_context, entry) => {
      records.push(entry);
    },
    id: () => crypto.randomUUID(),
    now: () => new Date('2026-10-13T08:00:00Z'),
  });

  return { service, records };
}

describe('list exports', () => {
  it('exports every page of the query and records the export without values', async () => {
    const { service, records } = fixture(150);
    const result = await service.export(context(), query, {
      number: 'Order',
      total: 'Total',
    });
    expect(result).toMatchObject({
      filename: 'orders-2026-10-13.csv',
      rows: 150,
      truncated: false,
    });
    expect(result.csv.split('\r\n')[0]).toBe('Order,Total');
    expect(result.csv).toContain('#149,1.00 EUR');
    expect(records).toEqual([
      expect.objectContaining({
        domain: 'orders',
        rows: 150,
        truncated: false,
        columns: ['number', 'total'],
        conditions: 1,
      }),
    ]);
  });

  it('cuts long lists off at the limit and says so in the file', async () => {
    const { service } = fixture(exportRowLimit + 250);
    const result = await service.export(context(), query, {
      '@truncated': 'More rows match than one export can hold.',
    });
    expect(result.rows).toBe(exportRowLimit);
    expect(result.truncated).toBe(true);
    expect(
      result.csv
        .trimEnd()
        .endsWith('More rows match than one export can hold.'),
    ).toBe(true);
  });

  it('needs export permission and refuses read-only support views', async () => {
    const { service, records } = fixture(1);
    await expect(
      service.export(context('member'), query, {}),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      service.export(context('owner', true), query, {}),
    ).rejects.toThrow();
    expect(records).toEqual([]);
  });
});
