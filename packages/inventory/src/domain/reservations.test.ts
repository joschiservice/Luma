import { describe, expect, it } from 'vitest';

import {
  allocationQuantity,
  consumeReservation,
  releaseReservation,
  type StockReservation,
} from './reservations.js';

const reservation: StockReservation = {
  id: 'reservation',
  orderId: 'order',
  orderLineId: 'line',
  skuId: 'sku',
  locationId: 'warehouse',
  unit: 'each',
  version: '9007199254740993',
  allocated: '5.000001',
  remaining: '5.000001',
  consumed: '0',
  released: '0',
  expiresAt: '2026-10-12T10:00:00Z',
  state: 'active',
  createdAt: '2026-10-11T10:00:00Z',
  updatedAt: '2026-10-11T10:00:00Z',
};
describe('exact native reservations', () => {
  it('leaves shortages as unallocated demand across locations', () => {
    expect(allocationQuantity('5.000001', '3.000001', '10', '4')).toEqual({
      allocated: '3.000001',
      unallocated: '2.999999',
    });
    expect(allocationQuantity('5', '10', '6', '4')).toEqual({
      allocated: '2',
      unallocated: '0',
    });
    expect(allocationQuantity('5', '0', '5', '0')).toEqual({
      allocated: '0',
      unallocated: '5',
    });
  });
  it('retains split shipment consumption and releases only the remainder', () => {
    const first = consumeReservation(
      reservation,
      '2.000001',
      '2026-10-12T09:00:00Z',
    );
    expect(first.remaining).toBe('3');
    expect(first.version).toBe('9007199254740994');
    const cancelled = releaseReservation(
      first,
      '3',
      'cancel',
      '2026-10-12T09:30:00Z',
    );
    expect(cancelled).toMatchObject({
      consumed: '2.000001',
      released: '3',
      remaining: '0',
      state: 'released',
    });
    expect(() =>
      consumeReservation(cancelled, '1', '2026-10-12T10:00:00Z'),
    ).toThrow();
    expect(() =>
      releaseReservation(cancelled, '1', 'cancel', '2026-10-12T10:00:00Z'),
    ).toThrow();
    expect(reservation.remaining).toBe('5.000001');
  });
  it('supports partial amendment and due expiry without consuming dispatched units twice', () => {
    const amended = releaseReservation(
      reservation,
      '1',
      'amend',
      '2026-10-12T09:00:00Z',
    );
    expect(amended.remaining).toBe('4.000001');
    expect(() =>
      releaseReservation(amended, '4.000001', 'expiry', '2026-10-12T09:59:59Z'),
    ).toThrow();
    expect(
      releaseReservation(amended, '4.000001', 'expiry', '2026-10-12T10:00:00Z'),
    ).toMatchObject({
      released: '5.000001',
      consumed: '0',
      remaining: '0',
      state: 'expired',
    });
  });
  it('rejects inconsistent balances and shipment quantities above remaining stock', () => {
    expect(() =>
      consumeReservation(
        { ...reservation, consumed: '1' },
        '1',
        '2026-10-12T10:00:00Z',
      ),
    ).toThrow();
    expect(() =>
      consumeReservation(reservation, '5.000002', '2026-10-12T10:00:00Z'),
    ).toThrow();
  });
});
