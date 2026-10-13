import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import { createStarshipitConnector } from './adapter.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const tenant = makeTenantContext(
  { userId: 'operator', sessionId: 'session' },
  {
    id: tenantId,
    name: 'Store',
    slug: 'store',
    status: 'active',
    dataRegion: 'EU',
  },
  builtInMembership(
    { id: 'member', organizationId: tenantId, userId: 'operator' },
    'owner',
  ),
  'request',
);
const invocation = { tenant, connectionId, provider: 'starshipit' };
const now = () => new Date('2026-10-12T12:00:00Z');
const order = {
  order_id: 1,
  order_number: '#1',
  status: 'Unshipped',
  items: [{ item_id: 11, quantity: 3, quantity_to_ship: 3, sku: 'TOTE' }],
};
const credentials = async () => ({
  token: 'key',
  subscriptionKey: 'subscription',
});

function fixture(fetch: typeof globalThis.fetch) {
  const recordObservations = vi.fn(async () => {});

  return {
    connector: createStarshipitConnector({
      tenantId,
      connectionId,
      credentials,
      fetch,
      now,
      recordObservations,
      readRetry: { attempts: 1, maxDelayMs: 0, sleep: async () => {} },
    }),
    recordObservations,
  };
}

describe('complete shipping reads', () => {
  it('scans all shipping states and binds cursors to connection and capability', async () => {
    const states: string[] = [];
    const { connector } = fixture(async (input) => {
      const url = new URL(String(input));
      states.push(url.searchParams.get('status') ?? '');

      return Response.json({
        succeeded: true,
        page_number: 1,
        total_pages: 0,
        total_records: 0,
        data: { orders: [] },
      });
    });
    const orders = connector.capabilities['orders.read']!;
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await orders.run(invocation, {
        limit: 10,
        ...(cursor ? { cursor } : {}),
      });
      cursor = result.nextCursor ?? undefined;
    }
    expect(states).toEqual(['Unshipped', 'Printed', 'Shipped']);
    expect(cursor).toBeUndefined();
    const first = await orders.run(invocation, { limit: 10 });
    await expect(
      connector.capabilities['fulfillment.read']!.run(invocation, {
        limit: 10,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ failure: { code: 'invalid_input' } });
  });
  it('point lookups match scan observations and absence is a complete empty page', async () => {
    const { connector } = fixture(async (input) =>
      new URL(String(input)).searchParams.has('order_id')
        ? Response.json({ success: true, order })
        : Response.json({
            succeeded: true,
            page_number: 1,
            total_pages: 1,
            total_records: 1,
            data: { orders: [{ order_id: 1 }] },
          }),
    );
    const orders = connector.capabilities['orders.read']!;
    const scanned = await orders.run(invocation, { limit: 10 });
    const point = await orders.run(invocation, {
      limit: 10,
      order: { externalId: '1', scopeKey: '' },
    });
    expect(point.items[0]?.data).toEqual(scanned.items[0]?.data);
    expect(point.nextCursor).toBeNull();
    const missing = fixture(async () => new Response(null, { status: 404 }));
    expect(
      await missing.connector.capabilities['orders.read']!.run(invocation, {
        limit: 1,
        order: { externalId: '1', scopeKey: '' },
      }),
    ).toEqual({ items: [], nextCursor: null, completeness: 'complete' });
  });
  it('failed tracking does not publish a partially represented page or work record', async () => {
    const { connector, recordObservations } = fixture(async (input) =>
      new URL(String(input)).pathname.endsWith('/track')
        ? new Response(null, { status: 503 })
        : Response.json({ success: true, order }),
    );
    await expect(
      connector.capabilities['fulfillment.read']!.run(invocation, {
        limit: 1,
        order: { externalId: '1', scopeKey: '' },
      }),
    ).rejects.toMatchObject({ failure: { effect: 'none' } });
    expect(recordObservations).not.toHaveBeenCalled();
  });
  it('rejects mismatched identity and future source times before storing evidence', async () => {
    const { connector, recordObservations } = fixture(async (input) =>
      new URL(String(input)).pathname.endsWith('/track')
        ? Response.json({
            success: true,
            results: {
              order_number: '#1',
              tracking_number: 'T1',
              tracking_status: 'Delivered',
              last_updated_date: '2026-10-12T13:00:00Z',
            },
          })
        : Response.json({ success: true, order }),
    );
    await expect(
      connector.capabilities['fulfillment.read']!.run(invocation, {
        limit: 1,
        order: { externalId: '1', scopeKey: '' },
      }),
    ).rejects.toMatchObject({ failure: { code: 'invalid_response' } });
    expect(recordObservations).not.toHaveBeenCalled();
    await expect(
      connector.capabilities['orders.read']!.run(
        { ...invocation, connectionId: crypto.randomUUID() },
        { limit: 1 },
      ),
    ).rejects.toMatchObject({ failure: { code: 'unavailable' } });
  });
});
