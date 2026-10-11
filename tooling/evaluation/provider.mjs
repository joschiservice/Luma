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
