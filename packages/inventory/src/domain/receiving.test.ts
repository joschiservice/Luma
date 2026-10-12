import { expect, it } from 'vitest';

import { receivingSignals, transferFacts } from './receiving.js';
import type { ShipmentData } from './transfers.js';

const now = new Date('2026-10-12T00:00:00Z');
const shipment: ShipmentData = {
  type: 'inventory_shipment',
  name: 'Shipment',
  status: 'partially_received',
  createdAt: null,
  shippedAt: null,
  receivedAt: null,
  expectedArrivalAt: '2026-10-11T23:00:00Z',
  quantity: '10',
  receivedQuantity: '8',
  acceptedQuantity: '7',
  rejectedQuantity: '1',
  tracking: null,
  lines: [
    {
      sourceId: { externalId: 'line', scopeKey: '' },
      sourceSku: null,
      skuId: null,
      unit: 'each',
      quantity: '10',
      accepted: '7',
      rejected: '1',
      unreceived: '2',
    },
  ],
};
const assess = (
  data: ShipmentData,
  observedAt = now.toISOString(),
  available = true,
) =>
  receivingSignals(
    transferFacts(data),
    data.type,
    data.status,
    observedAt,
    now,
    available,
  );
it('separates reported rejected units and overdue unconfirmed receipt from proven loss', () => {
  expect(transferFacts(shipment).unreceived).toBe('2');
  expect(assess(shipment)).toEqual(['rejected', 'receipt_late']);
  expect(assess({ ...shipment, status: 'received' })).toEqual([
    'rejected',
    'terminal_unreceived',
  ]);
});
it('does not treat cancellation-inclusive receipts as accepted units or invent shortages', () => {
  const data = {
    ...shipment,
    receivedQuantity: '10',
    lines: [{ ...shipment.lines![0]!, unreceived: '0' }],
  };
  expect(transferFacts(data).consistent).toBe(true);
  expect(assess(data)).toEqual(['rejected']);
});
it('pauses conclusions on unavailable, stale, future, missing or unknown evidence', () => {
  expect(assess(shipment, '2026-10-11T23:54:59Z')).toEqual([]);
  expect(assess(shipment, '2026-10-12T00:00:01Z')).toEqual([]);
  expect(assess(shipment, now.toISOString(), false)).toEqual([]);
  expect(assess({ ...shipment, lines: null })).toEqual([]);
  expect(assess({ ...shipment, status: 'unknown' })).toEqual([]);
});
it('requires internally reconciled totals before checking delay or rejection', () => {
  expect(assess({ ...shipment, quantity: '11' })).toEqual([
    'inconsistent_quantities',
  ]);
});
it('retains exact decimal quantities beyond floating-point precision', () => {
  const data: ShipmentData = {
    ...shipment,
    quantity: '99999999999999.123456',
    acceptedQuantity: '99999999999998.123455',
    rejectedQuantity: '0',
    receivedQuantity: '99999999999998.123455',
    lines: [
      {
        ...shipment.lines![0]!,
        quantity: '99999999999999.123456',
        accepted: '99999999999998.123455',
        rejected: '0',
        unreceived: '1.000001',
      },
    ],
  };
  expect(transferFacts(data)).toMatchObject({
    consistent: true,
    unreceived: '1.000001',
  });
});
