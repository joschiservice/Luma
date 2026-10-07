import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createJtlConnector } from '@luma/app-jtl';
import {
  createCapabilityRuntime,
  simulationTransport,
} from '@luma/connections/adapters';
import { createSimulationTransport } from '@luma/connections/composition';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createMemoryStore, createTransport } from '@luma/simulator-core';
import { jtl } from '@luma/simulator-jtl';

import { createApp } from '../../apps/simulator/dist/app.js';
import {
  createInstallationVerifier,
  createInstalledRuntime,
  createInstalledShippingMethodEffects,
} from '../apps/providers.mjs';
import { waitForRun } from './connect.mjs';
import { testSimulatorDatabase } from './database.mjs';

const tenantId = '00000000-0000-4000-8000-000000000001';
const context = makeTenantContext(
  { userId: 'owner', sessionId: 'session' },
  {
    id: tenantId,
    name: 'Test',
    slug: 'test',
    status: 'active',
    dataRegion: 'EU',
  },
  builtInMembership(
    { id: 'member', organizationId: tenantId, userId: 'owner' },
    'owner',
  ),
  'request',
);
const ref = (externalId) => ({ externalId, scopeKey: '' });
const input = {
  order: ref('1'),
  expectedShippingMethod: ref('7'),
  shippingMethod: ref('8'),
};
const target = {
  kind: 'jtl-onprem',
  baseUrl: 'https://jtl.synthetic.invalid/api/eazybusiness/',
  appId: 'LumaSimulator',
  appVersion: '1',
};
const credentials = { token: 'synthetic-only', challengeCode: 'synthetic' };
const token = 'integration-synthetic-token';

const connections = [
  {
    id: '00000000-0000-4000-8000-000000000002',
    label: 'SIMULATED JTL',
    provider: 'jtl',
    target,
    permissions: [
      'orders.read',
      'products.read',
      'inventory.read',
      'fulfillment.read',
      'orders.shipping-method.read',
      'orders.shipping-method.write',
      'suppliers.read',
      'purchase-orders.read',
    ],
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    label: 'SIMULATED Shopify',
    provider: 'shopify',
    target: { kind: 'shopify', shop: 'luma-synthetic-pilot.myshopify.com' },
    permissions: [
      'orders.read',
      'products.read',
      'inventory.read',
      'fulfillment.read',
      'inventory.available.reconcile',
      'returns.read',
      'customers.read',
    ],
  },
].map((connection) => ({
  ...connection,
  tenantId,
  appId: connection.provider,
  status: 'active',
  version: 1,
  credentialVersion: 1,
  granted: connection.permissions,
}));

/** Starts a host on the test database and returns a JSON control client. */
async function start(databaseUrl) {
  const app = await createApp({ databaseUrl, token, autonomous: false });
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const call = async (path, body, method) => {
    const response = await fetch(`${endpoint}/api/${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));

    return result;
  };

  return { app, endpoint, call };
}

function options(endpoint) {
  return {
    installations: {
      list: async () => connections,
      credential: async (_context, id) => ({
        connection: connections.find((c) => c.id === id),
        credentials,
      }),
      recordFailure: async () => {},
    },
    simulation: createSimulationTransport({
      endpoint,
      token,
      bindings: connections.map((c) => ({
        tenantId,
        connectionId: c.id,
        target: c.target,
        runId: 'test',
        instance: c.provider,
      })),
    }),
    jtlEndpoints: [],
    customerAccess: { contact: true, address: true },
    approveJtlEndpoint: async () => assert.fail('Production transport reached'),
    record: async () => {},
    recordObservations: async () => {},
  };
}

test('real installed adapters read remote state, verify a lost write after restart, and never redispatch', async (t) => {
  const databaseUrl = await testSimulatorDatabase(t);
  let host = await start(databaseUrl);
  // Hosts close inside the test: after hooks run first-in-first-out, before the database drop.
  try {
    const intent = {
      tenantId,
      connectionId: connections[0].id,
      capability: 'orders.shipping-method.write',
      capabilityVersion: '0',
      target: { kind: 'order', id: 'canonical' },
      parameters: {},
      preconditions: {
        evidenceRefs: ['diagnosis'],
        validUntil: new Date(Date.now() + 60000).toISOString(),
      },
      expectedPostcondition: { shippingMethodId: '8' },
    };
    const binding = {
      map: async () => input,
      checkPreconditions: async () => true,
    };
    await host.call('runs', {
      id: 'test',
      profile: 'test',
      chaos: 'calm',
      running: false,
    });
    await waitForRun(host.call, 'test');
    await host.call('runs/test/control', {
      action: 'command',
      instance: 'jtl',
      command: { kind: 'ship', id: '10', warehouse: '1' },
    });
    await host.call('runs/test/control', {
      action: 'command',
      instance: 'shopify',
      command: { kind: 'fulfill', order: '10' },
    });
    const verify = createInstallationVerifier({
      simulation: options(host.endpoint).simulation,
      jtlEndpoints: [],
    });
    for (const connection of connections) {
      const granted = await verify(connection, credentials);
      for (const permission of connection.permissions)
        assert.ok(
          granted.includes(permission),
          `${connection.provider}: ${permission}`,
        );
    }
    const read = async (connection, capability, extra = {}) =>
      createInstalledRuntime(options(host.endpoint)).read(context, {
        connectionId: connection.id,
        capability,
        version: '0',
        input: { limit: 1, ...extra },
      });
    for (const connection of connections)
      for (const capability of connection.permissions.filter(
        (name) =>
          name.endsWith('.read') && name !== 'orders.shipping-method.read',
      )) {
        const result = await read(connection, capability);
        assert.equal(
          result.ok,
          true,
          `${capability}: ${JSON.stringify(result)}`,
        );
        if (result.value.nextCursor) {
          const next = await read(connection, capability, {
            cursor: result.value.nextCursor,
          });
          assert.equal(next.ok, true, JSON.stringify(next));
        }
      }
    for (const [status, code] of [
      ['unavailable', 'transient'],
      ['rate-limited', 'rate_limited'],
      ['unauthorized', 'authentication'],
    ]) {
      await host.call('runs/test/control', {
        action: 'service-health',
        instance: 'jtl',
        status,
      });
      const blocked = await read(connections[0], 'orders.read');
      assert.equal(blocked.ok, false);
      assert.equal(blocked.error.code, code);
      assert.equal((await read(connections[1], 'orders.read')).ok, true);
    }
    await host.call('runs/test/control', {
      action: 'service-health',
      instance: 'jtl',
      status: 'healthy',
    });
    await host.call('runs/test/control', {
      action: 'fault',
      rule: {
        instance: 'jtl',
        operation: 'orders.shipping-method.write',
        resource: '1',
        kind: 'response-loss',
      },
    });
    const effect = await createInstalledShippingMethodEffects(
      options(host.endpoint),
      binding,
    ).resolve(context, intent);
    await assert.rejects(
      effect.execute(intent, 'logical-key'),
      (error) =>
        error.failure.effect === 'unknown' &&
        error.failure.retry === 'reconcile',
    );
    await host.app.close();
    host = await start(databaseUrl);
    const recreated = await createInstalledShippingMethodEffects(
      options(host.endpoint),
      binding,
    ).resolve(context, intent);
    assert.equal((await recreated.verify(intent)).outcome, 'passed');
    const run = await host.call('runs/test');
    assert.equal(run.faults[0].status, 'triggered');
    const writes = await host.call('runs/test/journal?kind=provider-write');
    assert.equal(writes.items.length, 1);
    const orders = await host.call('runs/test/records/jtl?kind=sales-order');
    assert.equal(
      orders.items.find((order) => order.id === '1').data.shippingMethodId,
      '8',
    );
    assert.throws(() => simulationTransport(connections[0]), /unavailable/);
    assert.throws(
      () =>
        simulationTransport(
          { ...connections[0], tenantId: 'other' },
          options(host.endpoint).simulation,
        ),
      /unavailable/,
    );
    assert.throws(
      () =>
        simulationTransport(
          connections[1],
          createSimulationTransport({
            endpoint: host.endpoint,
            token,
            bindings: [],
          }),
        ),
      /unavailable/,
    );
    // One transient failure is repeated in place; reads fail when every attempt fails.
    await host.call('runs/test/control', {
      action: 'fault',
      rule: {
        instance: 'shopify',
        operation: 'orders.read',
        kind: 'unavailable',
      },
    });
    assert.equal((await read(connections[1], 'orders.read')).ok, true);
    for (const [kind, code] of [
      ['unavailable', 'transient'],
      ['rate-limit', 'rate_limited'],
      ['malformed', 'invalid_response'],
      ['schema-drift', 'invalid_response'],
    ]) {
      await host.call('runs/test/control', {
        action: 'fault',
        rule: {
          instance: 'shopify',
          operation: 'orders.read',
          kind,
          remaining: 3,
        },
      });
      const result = await read(connections[1], 'orders.read');
      assert.equal(result.ok, false, kind);
      assert.equal(result.error.code, code, kind);
      for (const fault of (await host.call('runs/test')).faults)
        if (fault.status === 'armed')
          await host.call('runs/test/control', {
            action: 'disable',
            id: fault.id,
          });
    }
  } finally {
    await host.app.close();
  }
});

test('the chaos profile fails a seeded share of requests and the same requests on replay', async (t) => {
  const databaseUrl = await testSimulatorDatabase(t);
  const host = await start(databaseUrl);
  await host.call('runs', {
    id: 'test',
    profile: 'test',
    chaos: 'calm',
    running: false,
  });
  await waitForRun(host.call, 'test');
  const detail = await host.call('runs/test');
  const chaos = structuredClone(detail.chaosProfile);
  chaos.transport.errorRate = 0.3;
  chaos.transport.mix = {
    unavailable: 1,
    'rate-limit': 0,
    'server-error': 0,
    timeout: 0,
    reset: 0,
    malformed: 0,
    'schema-drift': 0,
  };
  chaos.transport.latency = { medianMs: 1, p99Ms: 2 };
  await host.call('runs/test/control', { action: 'chaos', chaos });
  const outcomes = async (call) => {
    const results = [];
    for (let index = 0; index < 40; index++) {
      const response = await call('runs/test/providers/jtl/request', {
        url: `${target.baseUrl}v1/items?pageNumber=1&pageSize=${index + 1}`,
        method: 'GET',
        headers: {
          authorization: 'Wawi synthetic',
          'x-appid': 'LumaSimulator',
          'x-appversion': '1',
        },
        body: null,
      });
      results.push(response.status);
    }

    return results;
  };
  const first = await outcomes(host.call);
  const failed = first.filter((status) => status === 503).length;
  assert.ok(failed >= 4 && failed <= 22, `failed ${failed} of 40`);
  // Retries are new occurrences with independent decisions; the first attempts match a new host.
  await host.app.close();
  const replay = await start(databaseUrl);
  try {
    assert.deepEqual(await outcomes(replay.call), first);
  } finally {
    await replay.app.close();
  }
});

test('an external change between preflight and PATCH exposes the real non-atomic boundary', async () => {
  const store = createMemoryStore();
  const config = {
    warehouses: [{ id: '1', name: 'Main warehouse' }],
    shippingMethods: [
      { id: '7', name: 'Standard' },
      { id: '8', name: 'Express' },
      { id: '9', name: 'Pickup' },
    ],
  };
  const providerContext = () => ({
    store,
    now: Date.now(),
    wallTime: Date.now(),
    instance: 'jtl',
    config,
    indexLagMs: 0,
    notify: () => {},
  });
  await jtl.command(providerContext(), {
    kind: 'seed-catalog',
    items: [
      {
        id: '1',
        sku: 'LUMA-001',
        name: 'Canvas tote',
        price: '24.00',
        gtin: null,
        manufacturer: 'Luma Goods',
        active: true,
        shopActive: true,
        stock: { 1: 100 },
        suppliers: [],
      },
    ],
    suppliers: [],
  });
  await jtl.command(providerContext(), {
    kind: 'order',
    id: '1',
    lines: [{ itemId: '1', quantity: 2, price: 24 }],
    shippingMethodId: '7',
    currency: 'EUR',
    paid: true,
  });
  let external = false;
  const fetch = createTransport(async (request) => {
    if (request.method === 'PATCH') {
      await jtl.command(providerContext(), {
        kind: 'shipping-method',
        id: '1',
        shippingMethodId: '9',
      });
      external = true;
    }

    return jtl.handle(providerContext(), request);
  });
  const connector = createJtlConnector({
    tenantId,
    connectionId: 'connection',
    connection: {
      kind: 'onprem',
      baseUrl: target.baseUrl,
      appId: target.appId,
      appVersion: '1',
      challengeCode: 'synthetic',
      apiKey: async () => credentials.token,
    },
    fetch,
    shippingMethodActions: true,
    recordObservations: async () => {},
  });
  const runtime = createCapabilityRuntime({
    resolve: async () => connector,
    record: async () => {},
  });
  const result = await runtime.write(context, {
    connectionId: 'connection',
    capability: 'orders.shipping-method.write',
    version: '0',
    input,
    idempotencyKey: 'race',
  });
  assert.equal(result.ok, true);
  assert.equal(external, true);
  assert.equal(
    (await store.get('sales-order', '1')).data.shippingMethodId,
    '8',
  );
});
