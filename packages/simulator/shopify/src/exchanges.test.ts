import { describe, expect, it } from 'vitest';

import { shopify } from './index.js';
import { readStock } from './read.js';
import {
  type ExchangeLineItemData,
  gid,
  type ReturnLineItemData,
} from './records.js';
import { catalog, createShop, graphqlRequest } from './test-support/shop.js';

const request = `mutation LumaExchangeRequest($input:ReturnInput!) { result:returnCreate(returnInput:$input) { return { id exchangeLineItems(first:10) { nodes { id processedQuantity processableQuantity lineItems { id } } } } userErrors { message } } }`;
const process = `mutation LumaExchangeProcess($input:ReturnProcessInput!) { result:returnProcess(input:$input) { return { id } userErrors { message } } }`;

async function fixture(variant = '12') {
  const shop = createShop({
    scopes: ['read_orders', 'read_all_orders', 'read_returns', 'write_returns'],
  });
  await shop.run({ kind: 'seed-catalog', products: catalog });
  const order = await shop.order({
    lines: [{ variant: '11', quantity: 1, price: '24.00' }],
  });
  await shop.run({
    kind: 'fulfill',
    order: order.id,
    carrier: 'DHL',
    trackingNumber: 'one',
    trackingUrl: 'https://example.test/one',
  });
  const shipments = (
    await shop.store.page({ kind: 'Fulfillment', parent: order.id, limit: 10 })
  ).items;
  const shipped = (
    await shop.store.page({
      kind: 'FulfillmentLineItem',
      parent: shipments[0]!.id,
      limit: 10,
    })
  ).items[0]!;
  const input = {
    orderId: order.gid,
    unprocessed: true,
    returnLineItems: [
      {
        fulfillmentLineItemId: gid('FulfillmentLineItem', shipped.id),
        quantity: 1,
        returnReason: 'OTHER',
        returnReasonNote:
          'luma-ex:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002',
      },
    ],
    exchangeLineItems: [
      { variantId: gid('ProductVariant', variant), quantity: 1 },
    ],
  };
  const send = (query: string, variables: Record<string, unknown>) =>
    shopify.handle(shop.context(), graphqlRequest(query, variables));
  const created = await send(request, { input });
  expect(created.body).not.toHaveProperty('errors');
  expect(created.committed).toBe(true);
  const returned = (
    await shop.store.page({ kind: 'Return', parent: order.id, limit: 10 })
  ).items[0]!;
  const lines = (
    await shop.store.page<ReturnLineItemData>({
      kind: 'ReturnLineItem',
      parent: returned.id,
      limit: 10,
    })
  ).items;
  const exchanges = (
    await shop.store.page<ExchangeLineItemData>({
      kind: 'ExchangeLineItem',
      parent: returned.id,
      limit: 10,
    })
  ).items;
  const processing = {
    returnId: gid('Return', returned.id),
    returnLineItems: lines.map((l) => ({
      id: gid('ReturnLineItem', l.id),
      quantity: l.data.quantity,
    })),
    exchangeLineItems: exchanges.map((l) => ({
      id: gid('ExchangeLineItem', l.id),
      quantity: l.data.quantity,
    })),
    notifyCustomer: false,
    note: input.returnLineItems[0]!.returnReasonNote,
  };

  return { shop, order, returned, processing, send };
}

describe('native exchanges', () => {
  it('requests without stock movement, processes once, and keeps a price difference held until an independently observed payment', async () => {
    const { shop, order, returned, processing, send } = await fixture();
    expect(await readStock(shop.context(), '12', '1')).toMatchObject({
      available: 40,
      committed: 0,
    });
    expect(
      (
        await shop.store.page({
          kind: 'FulfillmentOrder',
          parent: order.id,
          limit: 10,
        })
      ).items,
    ).toHaveLength(1);
    const result = await send(process, { input: processing });
    expect(result.body).not.toHaveProperty('errors');
    expect(result.committed).toBe(true);
    expect(await readStock(shop.context(), '12', '1')).toMatchObject({
      available: 39,
      committed: 1,
    });
    const works = (
      await shop.store.page({
        kind: 'FulfillmentOrder',
        parent: order.id,
        limit: 10,
      })
    ).items;
    expect(works).toHaveLength(2);
    expect(works[1]!.data).toMatchObject({
      status: 'ON_HOLD',
      holds: [{ reason: 'AWAITING_PAYMENT' }],
    });
    expect(
      await shop.query(
        'query($id:ID!){node(id:$id){...on Order{totalOutstandingSet{presentmentMoney{amount}}}}}',
        { id: order.gid },
      ),
    ).toMatchObject({
      data: {
        node: { totalOutstandingSet: { presentmentMoney: { amount: '2.5' } } },
      },
    });
    const repeated = await send(process, { input: processing });
    expect(repeated.committed).toBeUndefined();
    expect(
      (
        await shop.store.page({
          kind: 'FulfillmentOrder',
          parent: order.id,
          limit: 10,
        })
      ).items,
    ).toHaveLength(2);
    const cancelled = await send(
      'mutation($id:ID!){returnCancel(id:$id){return{id}userErrors{message}}}',
      { id: gid('Return', returned.id) },
    );
    expect(cancelled.committed).toBeUndefined();
    await shop.run({ kind: 'exchange-pay', order: order.id });
    expect(
      await shop.query(
        'query($id:ID!){node(id:$id){...on Order{totalOutstandingSet{presentmentMoney{amount}}}}}',
        { id: order.gid },
      ),
    ).toMatchObject({
      data: {
        node: { totalOutstandingSet: { presentmentMoney: { amount: '0.0' } } },
      },
    });
    expect(
      (await shop.store.get('FulfillmentOrder', works[1]!.id))!.data,
    ).toMatchObject({ status: 'ON_HOLD' });
  });

  it('refuses unavailable replacements without committing and permits cancellation of the pristine intent', async () => {
    const { shop, returned, processing, send } = await fixture();
    await shop.run({
      kind: 'stock',
      variant: '12',
      location: '1',
      quantity: 0,
    });
    const response = await send(process, { input: processing });
    expect(response.committed).toBeUndefined();
    expect(response.body).toMatchObject({
      data: {
        result: {
          return: null,
          userErrors: [{ message: 'Replacement unavailable' }],
        },
      },
    });
    const cancelled = await send(
      'mutation($id:ID!){returnCancel(id:$id){return{id status}userErrors{message}}}',
      { id: gid('Return', returned.id) },
    );
    expect(cancelled.body).toMatchObject({
      data: {
        returnCancel: { return: { status: 'CANCELED' }, userErrors: [] },
      },
    });
    expect(cancelled.committed).toBe(true);
  });
});
