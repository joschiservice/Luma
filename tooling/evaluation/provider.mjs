import { createMemoryStore, json, matchFault } from '@luma/simulator-core';
import { jtl, readOrder } from '@luma/simulator-jtl';
import { shopify } from '@luma/simulator-shopify';

const providers = { jtl, shopify };

/** Provider settings of the evaluation world: one warehouse, one shop, JTL shipping methods. */
const configs = {
  jtl: {
    warehouses: [{ id: '1', name: 'Main warehouse' }],
    shippingMethods: [
      { id: '7', name: 'Standard' },
      { id: '8', name: 'Express' },
      { id: '9', name: 'Pickup' },
    ],
  },
  shopify: {
    shop: 'evaluation.myshopify.com',
    name: 'Evaluation shop',
    currency: 'EUR',
    orderPrefix: 'SIM-',
    locations: [{ id: '1', name: 'Main warehouse' }],
    scopes: [
      'read_orders',
      'read_products',
      'read_inventory',
      'read_merchant_managed_fulfillment_orders',
    ],
  },
};

const retryAfter = { 'content-type': 'application/json', 'retry-after': '1' };

/**
 * Opens one provider of a serialized evaluation world. `save` writes the store back, so the
 * world stays a plain JSON checkpoint between calls.
 */
function open(provider, instance, events = []) {
  const store = createMemoryStore(provider[instance]);

  return {
    context: {
      store,
      now: provider.now,
      // Evaluation replays are deterministic, so real time follows the provider clock.
      wallTime: provider.now,
      instance,
      config: configs[instance],
      indexLagMs: 0,
      notify: (event) => events.push(event),
    },
    save() {
      provider[instance] = store.snapshot();
    },
  };
}

/**
 * Serves one provider request against the serialized world and applies its manual fault
 * rules before dispatch and after commit, as the simulator host does.
 */
export async function dispatch(provider, instance, request) {
  const target = { instance, ...providers[instance].identify(request) };
  const journal = (kind, detail) =>
    provider.journal.push({
      time: provider.now,
      kind,
      instance,
      resource: target.resource,
      detail,
    });
  journal('request', { method: request.method, operation: target.operation });
  const before = matchFault(
    provider.faults,
    { ...target, phase: 'before' },
    provider.now,
  );
  if (before) {
    journal('fault', { id: before.id, kind: before.kind });

    return before.kind === 'rate-limit'
      ? { ...json({ error: 'Too many requests' }, 429), headers: retryAfter }
      : { ...json({ error: 'Service unavailable' }, 503), headers: retryAfter };
  }
  const { context, save } = open(provider, instance);
  const response = await providers[instance].handle(context, request);
  save();
  if (response.committed) {
    journal('provider-write', { operation: target.operation });
    const after = matchFault(
      provider.faults,
      { ...target, phase: 'after-commit' },
      provider.now,
    );
    if (after) {
      journal('fault', { id: after.id, kind: after.kind });

      return { ...response, lost: true };
    }
  }
  journal('response', { status: response.status });

  return response;
}

/** Applies a merchant command, such as an external shipping-method change. */
export async function command(provider, instance, input) {
  const { context, save } = open(provider, instance);
  const result = await providers[instance].command(context, input);
  save();
  provider.journal.push({
    time: provider.now,
    kind: 'merchant',
    instance,
    detail: input,
  });

  return result;
}

/** Moves the evaluation clock forward; the evaluation world has no scheduled events. */
export function advance(provider, milliseconds) {
  provider.now += milliseconds;
}

/** Reads a JTL order's current shipping method. */
export async function shippingMethod(provider, orderId) {
  return (await readOrder(open(provider, 'jtl').context, orderId))
    ?.shippingMethodId;
}

/**
 * Builds the shared evaluation world: one tote with 100 units and open orders 1 and 10 for two
 * units each, shipped with Standard (7), in both JTL and Shopify.
 */
export async function createEvaluationProvider(
  now = Date.parse('2026-01-01T00:00:00Z'),
) {
  const provider = {
    now,
    faults: [],
    journal: [],
    jtl: undefined,
    shopify: undefined,
  };
  await command(provider, 'jtl', {
    kind: 'seed-catalog',
    items: [
      {
        id: '1',
        sku: 'LUMA-001',
        name: 'Canvas tote',
        price: '24.00',
        gtin: '4006381333931',
        manufacturer: 'Luma Goods',
        active: true,
        shopActive: true,
        stock: { 1: 100 },
        suppliers: [],
      },
    ],
    suppliers: [],
  });
  await command(provider, 'shopify', {
    kind: 'seed-catalog',
    products: [
      {
        id: '1',
        title: 'Canvas tote',
        vendor: 'Luma Goods',
        productType: 'Accessories',
        published: true,
        variants: [
          {
            id: '1',
            sku: 'LUMA-001',
            title: 'Default Title',
            price: '24.00',
            barcode: '4006381333931',
            stock: { 1: 100 },
          },
        ],
      },
    ],
  });
  for (const id of ['1', '10']) {
    await command(provider, 'jtl', {
      kind: 'order',
      id,
      externalNumber: `SIM-${id}`,
      lines: [{ itemId: '1', quantity: 2, price: 24 }],
      shippingMethodId: '7',
      currency: 'EUR',
      paid: true,
      warehouse: '1',
    });
    await command(provider, 'shopify', {
      kind: 'order',
      id,
      lines: [{ variant: '1', quantity: 2, price: '24.00' }],
      location: '1',
      shipping: 'standard',
      financialStatus: 'PAID',
    });
  }
  provider.journal = [];

  return provider;
}
