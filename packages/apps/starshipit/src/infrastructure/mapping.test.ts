import * as s from '@luma/connector-starshipit/schemas';
import { describe, expect, it } from 'vitest';

import { fulfillmentSnapshots, orderSnapshot, revision } from './mapping.js';

const order = s.order.parse({
  order_id: 1,
  order_number: '#1',
  status: 'Shipped',
  items: [
    {
      item_id: 11,
      sku: 'TOTE',
      description: 'Tote',
      quantity: 3,
      quantity_to_ship: 0,
    },
  ],
  packages: [{ package_id: 10 }],
});
const track = (overrides: Record<string, unknown> = {}) =>
  s.tracking.parse({
    order_number: '#1',
    order_status: 'Dispatched',
    tracking_status: 'In transit',
    tracking_number: 'T1',
    carrier_name: 'Courier',
    last_updated_date: '2026-10-12T12:00:00Z',
    shipment_date: '2026-10-12T10:00:00Z',
    tracking_url: 'https://courier.example/track/T1',
    ...overrides,
  });
describe('shipping evidence', () => {
  it('keeps provider identities scoped and order numbers descriptive', () => {
    expect(orderSnapshot(order).lines[0]).toMatchObject({
      id: { externalId: '11', scopeKey: '1' },
      sku: null,
      skuCode: 'TOTE',
    });
    expect(orderSnapshot(order).status).toBe('unknown');
  });
  it('assigns whole-order quantities only to one actual full dispatch', () => {
    const records = fulfillmentSnapshots(order, [track()]);
    expect(records[1]).toMatchObject({
      id: 'tracking:1:T1',
      data: {
        lines: [
          {
            orderLine: { externalId: '11', scopeKey: '1' },
            quantity: { amount: '3', unit: 'each' },
          },
        ],
        shipping: { stage: 'carrier' },
      },
    });
  });
  it('labels and manually dispatched order states never prove carrier handoff', () => {
    const shipment = fulfillmentSnapshots(order, [
      track({ tracking_status: 'Printed', order_status: 'Dispatched' }),
    ])[1]!;
    expect(shipment.data).toMatchObject({
      delivery: 'label_created',
      shipping: { stage: 'unknown' },
      lines: [],
    });
  });
  it('keeps split shipments unallocated and preserves both tracking identities', () => {
    const result = fulfillmentSnapshots(
      { ...order, packages: [{ package_id: '10' }, { package_id: '20' }] },
      [track(), track({ tracking_number: 'T2' })],
    );
    expect(result).toHaveLength(3);
    expect(result.slice(1).every((row) => row.data.lines.length === 0)).toBe(
      true,
    );
  });
  it('distinguishes an actual delivery attempt from an ambiguous carrier exception', () => {
    expect(
      fulfillmentSnapshots(order, [
        track({ tracking_status: 'Delivery attempted' }),
      ])[1]?.data,
    ).toMatchObject({
      status: 'shipped',
      delivery: 'attempted_delivery',
      shipping: { stage: 'carrier' },
    });
    expect(
      fulfillmentSnapshots(order, [track({ tracking_status: 'Exception' })])[1]
        ?.data,
    ).toMatchObject({
      status: 'failed',
      delivery: 'failed',
      shipping: { stage: 'unknown' },
      lines: [],
    });
  });
  it('ignores a reordered stale duplicate and deduplicates identical tracking events', () => {
    const newest = track({
      tracking_status: 'Delivered',
      last_updated_date: '2026-10-12T13:00:00Z',
    });
    for (const rows of [
      [newest, track(), newest],
      [track(), newest],
    ]) {
      const result = fulfillmentSnapshots(order, rows);
      expect(result).toHaveLength(2);
      expect(result[1]?.data.shipping?.stage).toBe('delivered');
    }
  });
  it('equal-time contradictory tracking is explicitly unknown', () => {
    const result = fulfillmentSnapshots(order, [
      track(),
      track({ tracking_status: 'Printed' }),
    ]);
    expect(result[1]?.data.shipping?.stage).toBe('unknown');
    expect(result[1]?.data.lines).toEqual([]);
  });
  it('rejects timezone inference and retains exact fractional read quantities', () => {
    const value = s.order.parse({
      ...order,
      order_date: '2026-10-12T12:00:00',
      items: [{ item_id: 11, quantity: '1.125000' }],
    });
    expect(value.order_date).toBeNull();
    expect(orderSnapshot(value).lines[0]?.quantity.amount).toBe('1.125');
  });
  it('fingerprints are stable after line reordering, and bind status changes', () => {
    const two = {
      ...order,
      items: [...order.items, { ...order.items[0]!, item_id: '12' }],
    };
    expect(revision(two)).toBe(
      revision({ ...two, items: [...two.items].reverse() }),
    );
    expect(revision(order)).not.toBe(revision({ ...order, status: 'Printed' }));
  });
});
