import { describe, expect, it } from 'vitest';

import { rateLimit } from './http.js';
import { shopify } from './index.js';
import { catalog, createShop, graphqlRequest } from './test-support/shop.js';

const page = (field: string, nodes = 'id') =>
  `query LumaPage($first: Int!, $after: String, $query: String, $reverse: Boolean) { page: ${field}(first: $first, after: $after, query: $query, reverse: $reverse) { nodes { ${nodes} } pageInfo { hasNextPage endCursor } } }`;

/** A shop with three orders created one minute apart. */
async function orders() {
  const shop = createShop({ indexLagMs: 5000 });
  await shop.run({ kind: 'seed-catalog', products: catalog });
  const created = [];
  for (let index = 0; index < 3; index += 1) {
    created.push(await shop.order());
    shop.advance(60_000);
  }

  return { shop, created };
}

describe('requests', () => {
  it('serves only authenticated POSTs to the 2026-07 GraphQL endpoint', async () => {
    const shop = createShop();
    const request = graphqlRequest('{ shop { myshopifyDomain } }');

    expect(
      (
        await shopify.handle(shop.context(), {
          ...request,
          url: request.url.replace('2026-07', '2025-01'),
        })
      ).status,
    ).toBe(404);
    expect(
      (await shopify.handle(shop.context(), { ...request, method: 'GET' }))
        .status,
    ).toBe(404);
    const denied = await shopify.handle(
      shop.context(),
      graphqlRequest('{ shop { myshopifyDomain } }', {}, null),
    );
    expect(denied).toEqual(shopify.unauthorized(request));
    expect(denied.status).toBe(401);
    expect(
      (await shopify.handle(shop.context(), { ...request, body: '{' })).status,
    ).toBe(400);
    const ok = await shopify.handle(shop.context(), request);
    expect(ok).toEqual({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-shopify-api-version': '2026-07',
      },
      body: {
        data: { shop: { myshopifyDomain: 'luma-test.myshopify.com' } },
        extensions: {
          cost: {
            requestedQueryCost: 1,
            actualQueryCost: 1,
            throttleStatus: {
              maximumAvailable: 2000,
              currentlyAvailable: 1999,
              restoreRate: 100,
            },
          },
        },
      },
    });
  });

  it('reports unknown fields and syntax errors as GraphQL errors', async () => {
    const shop = createShop();
    const unknown = await shopify.handle(
      shop.context(),
      graphqlRequest('query { orders(first: 1) { nodes { id colour } } }'),
    );
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({
      errors: [
        expect.objectContaining({
          message: 'Cannot query field "colour" on type "Order".',
          extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
        }),
      ],
    });
    expect((await shop.query('query {')).errors?.[0]?.message).toMatch(
      /Syntax Error/,
    );
    expect(
      (await shop.query('query { orders { nodes { id } } }')).errors?.[0]
        ?.message,
    ).toBe('You must provide one of first or last.');
    expect(
      (await shop.query('query { orders(first: 251) { nodes { id } } }'))
        .errors?.[0]?.message,
    ).toMatch(/between 0 and 250/);
  });

  it('refuses queries above the single query cost limit', async () => {
    const shop = createShop();
    const body = await shop.query(
      'query { orders(first: 250) { nodes { lineItems(first: 250) { nodes { id } } } } }',
    );

    expect(body.errors?.[0]?.extensions?.code).toBe('MAX_COST_EXCEEDED');
  });
});

describe('reads', () => {
  it('pages with cursors, reverse order and last', async () => {
    const { shop, created } = await orders();
    const ids = created.map((order) => `gid://shopify/Order/${order.id}`);
    const first = await shop.query(page('orders'), { first: 2 });
    const firstPage = first.data?.page as {
      nodes: { id: string }[];
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };
    expect(firstPage.nodes.map((node) => node.id)).toEqual(ids.slice(0, 2));
    expect(firstPage.pageInfo.hasNextPage).toBe(true);
    const second = await shop.query(page('orders'), {
      first: 2,
      after: firstPage.pageInfo.endCursor,
    });
    expect(second.data?.page).toEqual({
      nodes: [{ id: ids[2] }],
      pageInfo: { hasNextPage: false, endCursor: expect.any(String) },
    });
    const reversed = await shop.query(page('orders'), {
      first: 3,
      reverse: true,
    });
    expect(
      (reversed.data?.page as { nodes: { id: string }[] }).nodes.map(
        (node) => node.id,
      ),
    ).toEqual([...ids].reverse());
    const last = await shop.query('query { orders(last: 2) { nodes { id } } }');
    expect(last.data?.orders).toEqual({
      nodes: [{ id: ids[1] }, { id: ids[2] }],
    });
    expect(
      (await shop.query(page('orders'), { first: 1, after: 'not-a-cursor' }))
        .errors?.[0]?.message,
    ).toMatch(/Invalid cursor/);
  });

  it('sorts by update time and filters updated_at searches behind the index lag', async () => {
    const { shop, created } = await orders();
    const [a, b, c] = created.map((order) => order.id);
    await shop.run({ kind: 'hold', order: a!, reason: 'OTHER' });
    const since = new Date(shop.now - 90_000).toISOString();
    const query = `updated_at:>='${since}'`;
    const sorted = (variables: Record<string, unknown>) =>
      shop.query(
        'query LumaPage($first: Int!, $query: String) { page: orders(first: $first, query: $query, sortKey: UPDATED_AT) { nodes { id } } count: ordersCount(query: $query, limit: null) { count precision } }',
        variables,
      );

    const lagging = await sorted({ first: 10, query });
    expect(lagging.data).toEqual({
      page: { nodes: [{ id: `gid://shopify/Order/${c}` }] },
      count: { count: 1, precision: 'EXACT' },
    });
    shop.advance(5000);
    expect((await sorted({ first: 10, query })).data?.page).toEqual({
      nodes: [
        { id: `gid://shopify/Order/${c}` },
        { id: `gid://shopify/Order/${a}` },
      ],
    });
    expect((await sorted({ first: 10, query: null })).data?.page).toEqual({
      nodes: [b, c, a].map((id) => ({ id: `gid://shopify/Order/${id}` })),
    });
    const capped = await shop.query(
      'query { ordersCount(limit: 2) { count precision } }',
    );
    expect(capped.data?.ordersCount).toEqual({
      count: 2,
      precision: 'AT_LEAST',
    });
  });

  it('limits order history without read_all_orders', async () => {
    const shop = createShop({ scopes: ['read_orders'] });
    await shop.run({ kind: 'seed-catalog', products: catalog });
    const old = await shop.order();
    shop.advance(61 * 86_400_000);
    const recent = await shop.order();
    const body = await shop.query(
      `query { orders(first: 5) { nodes { id } } ordersCount { count } old: node(id: "gid://shopify/Order/${old.id}") { id } }`,
    );

    expect(body.data).toEqual({
      orders: { nodes: [{ id: `gid://shopify/Order/${recent.id}` }] },
      ordersCount: { count: 1 },
      old: null,
    });
  });

  it('resolves nodes, inline fragments, aliases and nested connections', async () => {
    const shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
    const order = await shop.order({ shipping: 'express' });
    await shop.run({
      kind: 'fulfill',
      order: order.id,
      carrier: 'DHL',
      trackingNumber: '42',
      trackingUrl: 'https://track.example/42',
    });
    const id = `gid://shopify/Order/${order.id}`;
    const body = await shop.query(
      `query LumaNode($id: ID!) { node(id: $id) { __typename ... on Order { id name closed cancelledAt displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet { shopMoney { amount currencyCode } } totalOutstandingSet { shopMoney { amount } } children: lineItems(first: 1) { nodes { name sku quantity variant { price inventoryItem { id } } } pageInfo { hasNextPage } } fulfillments { status displayStatus location { name } trackingInfo(first: 10) { company number url } } fulfillmentOrders(first: 5) { nodes { status supportedActions { action } assignedLocation { name location { id } } deliveryMethod { methodType presentedName } lineItems(first: 5) { nodes { totalQuantity remainingQuantity } } } } transactions { kind status amountSet { shopMoney { amount } } } events(first: 5) { nodes { ... on BasicEvent { action } } } } } }`,
      { id },
    );

    expect(body.errors).toBeUndefined();
    expect(body.data?.node).toEqual({
      __typename: 'Order',
      id,
      name: '#T1001',
      closed: true,
      cancelledAt: null,
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      currentTotalPriceSet: {
        shopMoney: { amount: '74.5', currencyCode: 'EUR' },
      },
      totalOutstandingSet: { shopMoney: { amount: '0.0' } },
      children: {
        nodes: [
          {
            name: 'Canvas tote - Natural',
            sku: 'TOTE-NAT',
            quantity: 2,
            variant: {
              price: '24.00',
              inventoryItem: { id: 'gid://shopify/InventoryItem/11' },
            },
          },
        ],
        pageInfo: { hasNextPage: true },
      },
      fulfillments: [
        {
          status: 'SUCCESS',
          displayStatus: 'CONFIRMED',
          location: { name: 'Hamburg Hub' },
          trackingInfo: [
            { company: 'DHL', number: '42', url: 'https://track.example/42' },
          ],
        },
      ],
      fulfillmentOrders: {
        nodes: [
          {
            status: 'CLOSED',
            supportedActions: [],
            assignedLocation: {
              name: 'Hamburg Hub',
              location: { id: 'gid://shopify/Location/1' },
            },
            deliveryMethod: {
              methodType: 'SHIPPING',
              presentedName: 'Express',
            },
            lineItems: {
              nodes: [
                { totalQuantity: 2, remainingQuantity: 0 },
                { totalQuantity: 1, remainingQuantity: 0 },
              ],
            },
          },
        ],
      },
      transactions: [
        {
          kind: 'SALE',
          status: 'SUCCESS',
          amountSet: { shopMoney: { amount: '74.5' } },
        },
      ],
      events: {
        nodes: [{ action: 'placed' }, { action: 'fulfillment_success' }],
      },
    });
    const missing = await shop.query(
      'query { node(id: "gid://shopify/Order/999") { id } }',
    );
    expect(missing.data).toEqual({ node: null });
    const level = await shop.query(
      'query { node(id: "gid://shopify/InventoryItem/11") { ... on InventoryItem { sku tracked variant { sku product { title priceRangeV2 { minVariantPrice { amount currencyCode } } } } inventoryLevel(locationId: "gid://shopify/Location/1") { id location { name isActive } quantities(names: ["available", "on_hand", "committed", "incoming"]) { name quantity } } } } }',
    );
    expect(level.data?.node).toEqual({
      sku: 'TOTE-NAT',
      tracked: true,
      variant: {
        sku: 'TOTE-NAT',
        product: {
          title: 'Canvas tote',
          priceRangeV2: {
            minVariantPrice: { amount: '24.0', currencyCode: 'EUR' },
          },
        },
      },
      inventoryLevel: {
        id: 'gid://shopify/InventoryLevel/1?inventory_item_id=11',
        location: { name: 'Hamburg Hub', isActive: true },
        quantities: [
          { name: 'available', quantity: 98 },
          { name: 'on_hand', quantity: 98 },
          { name: 'committed', quantity: 0 },
          { name: 'incoming', quantity: 0 },
        ],
      },
    });
  });

  it('searches customers by email and text and lists their orders', async () => {
    const shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
    const anna = await shop.run({
      kind: 'customer',
      customer: {
        firstName: 'Anna',
        lastName: 'Müller',
        email: 'anna@customer.example',
        phone: '+49 1',
        address: {
          address1: 'Hauptstraße 1',
          city: 'Berlin',
          zip: '10115',
          countryCode: 'DE',
        },
      },
    });
    await shop.run({
      kind: 'customer',
      customer: {
        firstName: 'Leon',
        lastName: 'Weber',
        email: 'leon@customer.example',
        phone: '+49 2',
        address: {
          address1: 'Seestraße 2',
          city: 'Hamburg',
          zip: '20095',
          countryCode: 'DE',
        },
      },
    });
    const first = await shop.order({ customer: anna.id });
    shop.advance(1000);
    const second = await shop.order({ customer: anna.id });
    const search = (query: string) =>
      shop.query(
        'query LumaCustomerList($query: String) { records: customers(first: 20, query: $query, sortKey: UPDATED_AT, reverse: true) { nodes { id displayName numberOfOrders amountSpent { amount currencyCode } defaultEmailAddress { emailAddress } defaultAddress { city countryCodeV2 } } } }',
        { query },
      );

    expect(
      (await search('email:"ANNA@customer.example"')).data?.records,
    ).toEqual({
      nodes: [
        {
          id: anna.gid,
          displayName: 'Anna Müller',
          numberOfOrders: '2',
          amountSpent: { amount: '149.0', currencyCode: 'EUR' },
          defaultEmailAddress: { emailAddress: 'anna@customer.example' },
          defaultAddress: { city: 'Berlin', countryCodeV2: 'DE' },
        },
      ],
    });
    expect(
      (
        (await search('"weber"')).data?.records as {
          nodes: { displayName: string }[];
        }
      ).nodes,
    ).toEqual([expect.objectContaining({ displayName: 'Leon Weber' })]);
    const byOrder = await shop.query(
      'query { records: orders(first: 20, query: "name:\\"T1001\\"") { nodes { customer { id } } } }',
    );
    expect(byOrder.data?.records).toEqual({
      nodes: [{ customer: { id: anna.gid } }],
    });
    const history = await shop.query(
      'query LumaCustomerOrders($id: ID!) { node(id: $id) { ... on Customer { orders(first: 20, sortKey: PROCESSED_AT, reverse: true) { nodes { id name } pageInfo { hasNextPage } } } } }',
      { id: anna.gid },
    );
    expect(history.data?.node).toEqual({
      orders: {
        nodes: [
          { id: second.gid, name: second.name },
          { id: first.gid, name: first.name },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
  });
});

describe('identification', () => {
  const target = (query: string, variables: Record<string, unknown> = {}) =>
    shopify.identify(graphqlRequest(query, variables));

  it('derives Luma capabilities from the parsed operation', () => {
    const id = 'gid://shopify/Order/1';
    expect(
      target(
        'query LumaExchangePrice($id:ID!) { node(id:$id) { ... on Return { id } } }',
        { id: 'gid://shopify/Return/1' },
      ),
    ).toEqual({
      operation: 'returns.exchange.price.read',
      resource: 'gid://shopify/Return/1',
      write: false,
    });
    expect(target(page('orders'), { first: 10 })).toEqual({
      operation: 'orders.read',
      write: false,
    });
    expect(target(page('products'))).toMatchObject({
      operation: 'products.read',
    });
    expect(target(page('inventoryItems'))).toMatchObject({
      operation: 'inventory.read',
    });
    expect(
      target(
        page(
          'orders',
          'id returns(first: 1) { nodes { id } } refunds(first: 1) { id }',
        ),
      ),
    ).toMatchObject({
      operation: 'returns.read',
    });
    expect(
      target(
        'query LumaNode($id: ID!) { node(id: $id) { ... on Order { fulfillments { id } } } }',
        { id },
      ),
    ).toEqual({ operation: 'fulfillment.read', resource: id, write: false });
    expect(
      target(
        'query LumaChildren($id: ID!) { node(id: $id) { ... on Order { children: lineItems(first: 100) { nodes { id } } } } }',
        { id },
      ),
    ).toMatchObject({ operation: 'orders.read', resource: id });
    expect(
      target(
        'query LumaScanStart($query: String) { currentAppInstallation { accessScopes { handle } } count: customersCount(query: $query, limit: null) { count precision } }',
      ),
    ).toMatchObject({ operation: 'customers.read' });
    expect(
      target('query VerifyInstallation { shop { myshopifyDomain } }'),
    ).toMatchObject({
      operation: 'connection.verify',
    });
    expect(
      target(
        'query LumaRecordAccess { currentAppInstallation { accessScopes { handle } } }',
      ),
    ).toMatchObject({
      operation: 'records.read',
    });
    expect(
      target(
        'mutation LumaInventoryCorrection($input: InventorySetQuantitiesInput!, $key: String!) { result: inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { code } } }',
        {
          input: {
            quantities: [{ inventoryItemId: 'gid://shopify/InventoryItem/11' }],
          },
        },
      ),
    ).toEqual({
      operation: 'inventory.available.reconcile',
      resource: 'gid://shopify/InventoryItem/11',
      write: true,
    });
    expect(
      target(
        'mutation LumaFulfillmentRecovery($id: ID!) { result: fulfillmentOrderMove(id: $id, newLocationId: "x") { userErrors { message } } }',
        { id: 'gid://shopify/FulfillmentOrder/5' },
      ),
    ).toEqual({
      operation: 'fulfillment.move',
      resource: 'gid://shopify/FulfillmentOrder/5',
      write: true,
    });
    expect(shopify.identify({ ...graphqlRequest('x'), body: 'nope' })).toEqual({
      operation: 'unknown',
      write: false,
    });
  });
});

describe('rate limit and drift', () => {
  it('approximates query cost and answers throttled requests like Shopify', () => {
    const limit = shopify.rateLimit!;
    expect(limit.capacity).toBe(2000);
    expect(limit.restorePerSecond).toBe(100);
    expect(limit.cost(graphqlRequest(page('orders'), { first: 100 }))).toBe(
      102,
    );
    expect(
      limit.cost(
        graphqlRequest(
          'query ($id: ID!) { node(id: $id) { ... on Order { id currentTotalPriceSet { shopMoney { amount } } } ... on Product { id } } }',
          { id: 'x' },
        ),
      ),
    ).toBe(3);
    expect(
      limit.cost(
        graphqlRequest(
          'mutation { fulfillmentOrderOpen(id: "x") { userErrors { message } } }',
        ),
      ),
    ).toBe(10);

    const throttled = limit.reject(102, 40.7);
    expect(throttled.status).toBe(200);
    expect(throttled.body).toEqual({
      errors: [
        {
          message: 'Throttled',
          extensions: expect.objectContaining({ code: 'THROTTLED' }),
        },
      ],
      extensions: {
        cost: {
          requestedQueryCost: 102,
          actualQueryCost: null,
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: 40,
            restoreRate: 100,
          },
        },
      },
    });
    expect(
      limit.annotate!(
        { status: 200, headers: {}, body: { data: {} } },
        102,
        1898,
      ).body,
    ).toEqual({
      data: {},
      extensions: {
        cost: {
          requestedQueryCost: 102,
          actualQueryCost: 102,
          throttleStatus: {
            maximumAvailable: 2000,
            currentlyAvailable: 1898,
            restoreRate: 100,
          },
        },
      },
    });
  });

  it('reports the actual cost of the returned items, which Shopify deducts', async () => {
    const { shop } = await orders();
    const response = await shopify.handle(
      shop.context(),
      graphqlRequest(page('orders'), { first: 100 }),
    );

    expect(response.body).toMatchObject({
      extensions: { cost: { requestedQueryCost: 102, actualQueryCost: 5 } },
    });
    expect(
      shopify.rateLimit!.annotate!(response, 102, 1500).body,
    ).toMatchObject({
      extensions: {
        cost: {
          requestedQueryCost: 102,
          actualQueryCost: 5,
          throttleStatus: { currentlyAvailable: 1500 },
        },
      },
    });
    expect(rateLimit.actualCost(response)).toBe(5);
  });

  it('drifts the first ID of a successful response to null', async () => {
    const { shop } = await orders();
    const response = await shopify.handle(
      shop.context(),
      graphqlRequest(page('orders'), { first: 2 }),
    );
    const drifted = shopify.drift(response).body as {
      data: { page: { nodes: { id: string | null }[] } };
    };

    expect(drifted.data.page.nodes[0]?.id).toBeNull();
    expect(drifted.data.page.nodes[1]?.id).toEqual(expect.any(String));
    expect((response.body as typeof drifted).data.page.nodes[0]?.id).toEqual(
      expect.any(String),
    );
    const scopes = shopify.drift(
      await shopify.handle(
        shop.context(),
        graphqlRequest(
          '{ currentAppInstallation { accessScopes { handle } } }',
        ),
      ),
    ).body as {
      data: {
        currentAppInstallation: { accessScopes: { handle: string | null }[] };
      };
    };
    expect(
      scopes.data.currentAppInstallation.accessScopes[0]?.handle,
    ).toBeNull();
  });
});
