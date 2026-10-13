import { ConnectorError } from '@luma/connections';
import * as s from '@luma/connector-starshipit/schemas';
import { describe, expect, it, vi } from 'vitest';

import { dispatchUpdate, type UpdateDispatchPorts } from './update-dispatch.js';
import type { UpdateRun } from './update-store.js';

const run: UpdateRun = {
  id: 'operation',
  tenantId: 'tenant',
  connectionId: 'connection',
  orderId: '1',
  revision: 'revision',
  observedAt: '2026-10-12T12:00:00Z',
  lines: [{ lineItemId: '11', currentQuantity: 3, quantity: 2 }],
  authority: {
    revision: 1,
    connectionId: 'source',
    observationId: 'obs',
    canonicalOrderId: 'order',
  },
  action: {
    schemaVersion: 1,
    id: 'operation',
    tenantId: 'tenant',
    connectionId: 'connection',
    capability: 'orders.quantity.update',
    capabilityVersion: '0',
    target: { kind: 'starshipit_order_update', id: 'operation' },
    parameters: {},
    preconditions: { evidenceRefs: [], validUntil: '2026-10-12T12:00:00Z' },
    expectedPostcondition: {},
    risk: 'medium',
    proposedBy: { kind: 'user', id: 'user' },
    expiresAt: '2026-10-12T12:00:00Z',
  },
};

function fixture() {
  let sent = false;
  const order = s.order.parse({
    order_id: 1,
    status: 'Unshipped',
    items: [
      { item_id: 11, quantity: 3, sku: 'TOTE', weight: 0.5 },
      { item_id: 12, quantity: 1, description: 'Gift wrap' },
    ],
  });
  const ports: UpdateDispatchPorts = {
    unchanged: async () => true,
    read: async () => ({ order, revision: 'revision' }),
    send: async () => {
      if (sent) return false;
      sent = true;

      return true;
    },
    update: vi.fn(async () => ({
      success: true,
      order: {
        ...order,
        items: order.items.map((line) => ({
          ...line,
          quantity: line.item_id === '11' ? 2 : line.quantity,
        })),
      },
    })),
    accepted: async () => 'evidence',
  };

  return { ports, order };
}

describe('one-shot downstream update', () => {
  it('fences concurrent starts and reconstructed workers and retains unchanged items', async () => {
    const { ports } = fixture();
    const results = await Promise.allSettled([
      dispatchUpdate(run, 'key', ports),
      dispatchUpdate(run, 'key', ports),
    ]);
    expect(
      results.filter((value) => value.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(ports.update).toHaveBeenCalledTimes(1);
    expect(ports.update).toHaveBeenCalledWith({
      order_id: 1,
      items: [
        expect.objectContaining({ item_id: 11, quantity: 2, weight: '0.5' }),
        expect.objectContaining({ item_id: 12, quantity: 1 }),
      ],
    });
    await expect(
      dispatchUpdate(run, 'key', { ...ports }),
    ).rejects.toMatchObject({ failure: { effect: 'none' } });
    expect(ports.update).toHaveBeenCalledTimes(1);
  });
  it('withholds stale evidence, removed grants and release-off operations before any fence or write', async () => {
    const { ports } = fixture();
    ports.unchanged = async () => false;
    const send = vi.spyOn(ports, 'send');
    await expect(dispatchUpdate(run, 'key', ports)).rejects.toMatchObject({
      failure: { code: 'conflict', effect: 'none' },
    });
    expect(send).not.toHaveBeenCalled();
    expect(ports.update).not.toHaveBeenCalled();
  });
  it('blocks label generation that races a review', async () => {
    const { ports, order } = fixture();
    ports.read = async () => ({
      order: { ...order, status: 'Printed' },
      revision: 'revision',
    });
    await expect(dispatchUpdate(run, 'key', ports)).rejects.toMatchObject({
      failure: { effect: 'none' },
    });
    expect(ports.update).not.toHaveBeenCalled();
  });
  it('lost acknowledgements never permit a retry', async () => {
    const { ports } = fixture();
    ports.update = vi.fn(async () => {
      throw new ConnectorError({
        code: 'timeout',
        effect: 'unknown',
        retry: 'never',
      });
    });
    await expect(dispatchUpdate(run, 'key', ports)).rejects.toMatchObject({
      failure: { effect: 'unknown' },
    });
    await expect(dispatchUpdate(run, 'key', ports)).rejects.toMatchObject({
      failure: { effect: 'none' },
    });
    expect(ports.update).toHaveBeenCalledTimes(1);
  });
  it('malformed successful acknowledgements are uncertain and retain the fence', async () => {
    const { ports } = fixture();
    ports.update = vi.fn(async () => ({ success: true, order: {} }));
    await expect(dispatchUpdate(run, 'key', ports)).rejects.toMatchObject({
      failure: { code: 'invalid_response', effect: 'unknown' },
    });
    await expect(dispatchUpdate(run, 'key', ports)).rejects.toMatchObject({
      failure: { effect: 'none' },
    });
    expect(ports.update).toHaveBeenCalledTimes(1);
  });
});
