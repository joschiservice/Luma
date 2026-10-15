import type { TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import type { PositionSource } from './detection-monitor.js';
import { createStockRefresh } from './stock-refresh.js';

const context = { tenantId: 't' } as TenantContext;
const now = new Date('2026-10-07T12:00:00.000Z');
const source = (connectionId: string, secondsOld: number): PositionSource => ({
  connectionId,
  provider: 'jtl',
  sku: { externalId: '341', scopeKey: '' },
  location: { externalId: 'all-warehouses', scopeKey: '' },
  mappedAt: now.toISOString(),
  mappingIds: [],
  observedAt: new Date(+now - secondsOld * 1000).toISOString(),
});
const observation = (connectionId: string, externalId = '341') => ({
  id: `obs-${connectionId}`,
  source: {
    tenantId: 't',
    connectionId,
    provider: 'jtl',
    resource: 'sku',
    externalId,
    scopeKey: 'all-warehouses',
  },
  kind: 'snapshot',
  observedAt: now.toISOString(),
  data: {},
});

function fixture(
  sources: PositionSource[],
  read: (connectionId: string) => unknown,
) {
  const project = vi.fn(async () => true);
  const log = vi.fn();
  const capabilities = {
    read: vi.fn(
      async (_context: TenantContext, request: { connectionId: string }) =>
        read(request.connectionId),
    ),
  };
  const refresh = createStockRefresh({
    sources: { positionSources: async () => sources },
    capabilities: capabilities as never,
    project,
    now: () => now,
    log,
  });

  return { refresh, project, log, capabilities };
}

const page = (items: unknown[]) => ({
  ok: true,
  value: { items, nextCursor: null, completeness: 'complete' },
});

describe('stock refresh', () => {
  it('rereads only stale sources and stores the matching read', async () => {
    const f = fixture([source('stale', 300), source('fresh', 10)], (id) =>
      page([observation(id, 'other'), observation(id)]),
    );

    expect(await f.refresh.refresh(context, 'position')).toBe(1);
    expect(f.capabilities.read).toHaveBeenCalledTimes(1);
    expect(f.project).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ id: 'obs-stale' }),
      'position',
    );
  });

  it('forces only the incident authority through background admission without rereading Shopify', async () => {
    const f = fixture([source('erp', 0), source('shopify', 0)], (id) =>
      page([observation(id)]),
    );
    expect(
      await f.refresh.refresh(context, 'position', 0, {
        connectionId: 'erp',
        readPurpose: 'incremental',
      }),
    ).toBe(1);
    expect(f.capabilities.read).toHaveBeenCalledExactlyOnceWith(
      context,
      expect.objectContaining({
        connectionId: 'erp',
        readPurpose: 'incremental',
      }),
    );
  });

  it('keeps the stored report when a source cannot be read', async () => {
    const f = fixture([source('down', 300)], () => ({
      ok: false,
      error: { code: 'unavailable' },
    }));

    expect(await f.refresh.refresh(context, 'position')).toBe(0);
    expect(f.project).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalled();
  });

  it('stores nothing when the source no longer reports the record', async () => {
    const f = fixture([source('gone', 300)], (id) =>
      page([observation(id, 'other')]),
    );

    expect(await f.refresh.refresh(context, 'position', 0)).toBe(0);
    expect(f.project).not.toHaveBeenCalled();
  });
});
