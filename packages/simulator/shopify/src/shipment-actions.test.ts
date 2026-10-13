import { describe, expect, it } from 'vitest';

import { catalog, createShop } from './test-support/shop.js';

const read = `query LumaShipmentPublishingRead($id:ID!) { node(id:$id) { ... on Order { id fulfillmentOrders(first:5) { nodes { id assignedLocation { location { id } } lineItems(first:20) { nodes { id remainingQuantity lineItem { id } } } } } fulfillments(first:5) { id trackingInfo(first:5) { company number url } fulfillmentLineItems(first:20) { nodes { quantity lineItem { id } } } } } } }`;
const create = `mutation LumaShipmentPublishingCreate($fulfillment:FulfillmentInput!) { result:fulfillmentCreate(fulfillment:$fulfillment) { fulfillment { id } userErrors { field message } } }`;
const update = `mutation LumaShipmentPublishingTracking($id:ID!,$tracking:FulfillmentTrackingInput!,$notify:Boolean) { result:fulfillmentTrackingInfoUpdate(fulfillmentId:$id,trackingInfoInput:$tracking,notifyCustomer:$notify) { fulfillment { id trackingInfo(first:5) { company number url } } userErrors { field message } } }`;

interface Order {
  fulfillmentOrders: {
    nodes: {
      id: string;
      lineItems: {
        nodes: {
          id: string;
          remainingQuantity: number;
          lineItem: { id: string };
        }[];
      };
    }[];
  };
  fulfillments: {
    id: string;
    trackingInfo: { number: string }[];
    fulfillmentLineItems: {
      nodes: { quantity: number; lineItem: { id: string } }[];
    };
  }[];
}

async function fixture() {
  const shop = createShop();
  await shop.run({ kind: 'seed-catalog', products: catalog });
  const order = await shop.order();
  const body = await shop.query(read, { id: order.gid });
  expect(body.errors).toBeUndefined();
  const current = body.data?.node as Order;
  const work = current.fulfillmentOrders.nodes[0]!,
    line = work.lineItems.nodes[0]!;
  const fulfill = (quantity: number, number = 'parcel-1') =>
    shop.query(create, {
      fulfillment: {
        notifyCustomer: false,
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: work.id,
            fulfillmentOrderLineItems: [{ id: line.id, quantity }],
          },
        ],
        trackingInfo: {
          company: 'Synthetic',
          numbers: [number],
          urls: [`https://tracking.example.test/${number}`],
        },
      },
    });

  return { shop, order, work, line, fulfill };
}

describe('native Shopify shipment mutations', () => {
  it('publishes an exact partial parcel and a second parcel without changing another line', async () => {
    const { shop, order, fulfill, line } = await fixture();
    const first = await fulfill(1);
    expect(first.errors).toBeUndefined();
    expect(first.data?.result).toMatchObject({ userErrors: [] });
    let body = await shop.query(read, { id: order.gid }),
      current = body.data?.node as Order;
    expect(current.fulfillments).toHaveLength(1);
    expect(current.fulfillments[0]?.fulfillmentLineItems.nodes).toEqual([
      { quantity: 1, lineItem: { id: line.lineItem.id } },
    ]);
    expect(
      current.fulfillmentOrders.nodes[0]?.lineItems.nodes.find(
        (l) => l.id === line.id,
      )?.remainingQuantity,
    ).toBe(1);
    const second = await fulfill(1, 'parcel-2');
    expect(second.data?.result).toMatchObject({ userErrors: [] });
    body = await shop.query(read, { id: order.gid });
    current = body.data?.node as Order;
    expect(current.fulfillments).toHaveLength(2);
  });
  it('updates tracking for the exact shipment and rejects over-fulfillment and a cancelled order', async () => {
    const { shop, order, fulfill } = await fixture();
    await fulfill(1);
    const current = (await shop.query(read, { id: order.gid })).data
      ?.node as Order;
    const tracked = await shop.query(update, {
      id: current.fulfillments[0]!.id,
      tracking: {
        company: 'Synthetic',
        numbers: ['corrected'],
        urls: ['https://tracking.example.test/corrected'],
      },
      notify: true,
    });
    expect(tracked.data?.result).toMatchObject({
      userErrors: [],
      fulfillment: { trackingInfo: [{ number: 'corrected' }] },
    });
    expect((await fulfill(2)).data?.result).toMatchObject({
      fulfillment: null,
      userErrors: [{ message: 'Line allocation changed' }],
    });
    const cancelled = await fixture();
    await cancelled.shop.run({
      kind: 'cancel',
      order: cancelled.order.id,
      reason: 'CUSTOMER',
    });
    expect((await cancelled.fulfill(1)).data?.result).toMatchObject({
      fulfillment: null,
    });
  });
});

it('combines exact fulfillment-order allocations at one warehouse into one native shipment', async () => {
  const { shop, order, work, line } = await fixture();
  const workId = work.id.split('/').at(-1)!,
    lineId = line.id.split('/').at(-1)!;
  const originalWork = await shop.store.get('FulfillmentOrder', workId),
    originalLine = await shop.store.get('FulfillmentOrderLineItem', lineId);
  expect(originalWork && originalLine).toBeTruthy();
  await shop.store.put(
    'FulfillmentOrderLineItem',
    lineId,
    {
      ...(originalLine!.data as Record<string, unknown>),
      totalQuantity: 1,
      remainingQuantity: 1,
    },
    { parent: workId, updatedAt: shop.now },
  );
  await shop.store.put('FulfillmentOrder', '9991', originalWork!.data, {
    parent: order.id,
    updatedAt: shop.now,
  });
  await shop.store.put(
    'FulfillmentOrderLineItem',
    '9992',
    {
      ...(originalLine!.data as Record<string, unknown>),
      fulfillmentOrder: '9991',
      totalQuantity: 1,
      remainingQuantity: 1,
    },
    { parent: '9991', updatedAt: shop.now },
  );
  const result = await shop.query(create, {
    fulfillment: {
      notifyCustomer: false,
      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId: work.id,
          fulfillmentOrderLineItems: [{ id: line.id, quantity: 1 }],
        },
        {
          fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/9991',
          fulfillmentOrderLineItems: [
            { id: 'gid://shopify/FulfillmentOrderLineItem/9992', quantity: 1 },
          ],
        },
      ],
      trackingInfo: {
        company: 'Synthetic',
        numbers: ['combined'],
        urls: ['https://tracking.example.test/combined'],
      },
    },
  });
  expect(result.errors).toBeUndefined();
  expect(result.data?.result).toMatchObject({ userErrors: [] });
  const current = (await shop.query(read, { id: order.gid })).data
    ?.node as Order;
  expect(current.fulfillments).toHaveLength(1);
  expect(current.fulfillments[0]?.fulfillmentLineItems.nodes).toEqual([
    { quantity: 2, lineItem: line.lineItem },
  ]);
});
