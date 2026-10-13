import {
  createMemoryStore,
  type ProviderEvent,
  type ProviderRequest,
} from '@luma/simulator-core';
import { describe, expect, it } from 'vitest';

import {
  starshipit,
  type StarshipitContext,
  type StarshipitOrder,
} from './index.js';

const at = Date.parse('2026-10-01T08:00:00Z');
const order: StarshipitOrder = {
  order_id: 1,
  order_number: '#TEST',
  order_date: new Date(at).toISOString(),
  last_updated_date: new Date(at).toISOString(),
  status: 'Unshipped',
  destination: {},
  packages: [],
  items: [
    {
      item_id: 11,
      sku: 'SKU',
      description: 'Tote',
      quantity: 3,
      weight: 0.2,
      value: 12,
    },
  ],
};

async function environment() {
  const events: ProviderEvent[] = [];
  const context: StarshipitContext = {
    store: createMemoryStore(),
    now: at,
    wallTime: at,
    instance: 'starshipit',
    config: { name: 'Synthetic' },
    indexLagMs: 0,
    notify: (event) => events.push(event),
  };
  await starshipit.command(context, { kind: 'order', order });

  return { context, events };
}

const request = (items: unknown): ProviderRequest => ({
  method: 'PUT',
  url: 'https://api.starshipit.com/api/orders',
  headers: {
    'starshipit-api-key': 'synthetic',
    'ocp-apim-subscription-key': 'synthetic',
  },
  body: JSON.stringify({ order: { order_id: 1, items } }),
});

describe('provider quantity writes', () => {
  it('preserves original item fields and blocks dispatch after a label is printed', async () => {
    const { context } = await environment();
    expect(
      (
        await starshipit.handle(
          context,
          request([{ ...order.items[0], quantity: 2 }]),
        )
      ).committed,
    ).toBe(true);
    expect(
      (await context.store.get<StarshipitOrder>('order', '1'))?.data.items[0],
    ).toEqual({ ...order.items[0], quantity: 2 });
    await starshipit.command(context, {
      kind: 'status',
      order: '1',
      status: 'Printed',
    });
    const before = await context.store.get('order', '1');
    const blocked = await starshipit.handle(
      context,
      request([{ ...order.items[0], quantity: 1 }]),
    );
    expect(blocked.status).toBe(400);
    expect(blocked.committed).toBeUndefined();
    expect(await context.store.get('order', '1')).toEqual(before);
  });

  it('rejects omitted, repeated, unknown and negative items without changing authoritative state', async () => {
    const { context, events } = await environment();
    const before = await context.store.get('order', '1');
    for (const items of [
      [],
      [order.items[0], order.items[0]],
      [{ ...order.items[0], item_id: 99 }],
      [{ ...order.items[0], quantity: -1 }],
    ]) {
      expect((await starshipit.handle(context, request(items))).status).toBe(
        400,
      );
      expect(await context.store.get('order', '1')).toEqual(before);
    }
    expect(events).toHaveLength(1);
  });

  it('denies unauthenticated updates before changing the record', async () => {
    const { context } = await environment();
    const before = await context.store.get('order', '1');
    expect(
      (
        await starshipit.handle(context, {
          ...request(order.items),
          headers: {},
        })
      ).status,
    ).toBe(401);
    expect(await context.store.get('order', '1')).toEqual(before);
  });
});
