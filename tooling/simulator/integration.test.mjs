import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createJtlConnector } from '@luma/app-jtl';
import { createShopifyConnector } from '@luma/app-shopify';
import {
  createCapabilityRuntime,
  simulationTransport,
} from '@luma/connections/adapters';
import { createSimulationTransport } from '@luma/connections/composition';
import { makeTenantContext } from '@luma/identity/composition';

import { createApp } from '../../apps/simulator/dist/app.js';
import {
  advanceRun,
  createRun,
  dispatch,
  mutate,
} from '../../apps/simulator/dist/run.js';
import { createTransport } from '../../packages/simulator/core/dist/index.js';
import {
  createInstallationVerifier,
  createInstalledRuntime,
  createInstalledShippingMethodEffects,
} from '../apps/providers.mjs';
import { observeProviders } from './observations.mjs';

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
  { id: 'member', organizationId: tenantId, userId: 'owner', role: 'owner' },
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

test('real installed adapters read remote state, verify a lost write after restart, and never redispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma44-integration-'));
  const token = 'integration-synthetic-token';
  let app = await createApp(join(directory, 'runs.sqlite'), token, false);
  let endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const call = async (path, body) => {
    const response = await fetch(`${endpoint}/api/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 200);

    return response.json();
  };
  const connections = [
    {
      id: '00000000-0000-4000-8000-000000000002',
      tenantId,
      label: 'SIMULATED JTL',
      provider: 'jtl',
      appId: 'jtl',
      target,
      permissions: [
        'orders.read',
        'products.read',
        'inventory.read',
        'fulfillment.read',
        'orders.shipping-method.read',
        'orders.shipping-method.write',
      ],
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      tenantId,
      label: 'SIMULATED Shopify',
      provider: 'shopify',
      appId: 'shopify',
      target: { kind: 'shopify', shop: 'luma-synthetic-test.myshopify.com' },
      permissions: [
        'orders.read',
        'products.read',
        'inventory.read',
        'fulfillment.read',
      ],
    },
  ].map((c) => ({
    ...c,
    status: 'active',
    version: 1,
    credentialVersion: 1,
    granted: c.permissions,
  }));
  const observations = [];
  const manifest = () => ({
    endpoint,
    token,
    bindings: connections.map((c) => ({
      tenantId,
      connectionId: c.id,
      target: c.target,
      runId: 'test',
      instance: c.target.kind === 'shopify' ? 'shopify' : 'jtl',
    })),
  });
  const options = () => ({
    installations: {
      list: async () => connections,
      credential: async (_context, id) => ({
        connection: connections.find((c) => c.id === id),
        credentials,
      }),
      recordFailure: async () => {},
    },
    simulation: createSimulationTransport(manifest()),
    jtlEndpoints: [],
    approveJtlEndpoint: async () => assert.fail('Production transport reached'),
    record: async () => {},
    recordObservations: async (evidence) => observations.push(evidence),
  });
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
  try {
    await call('runs', { id: 'test' });
    await call('runs/test/control', {
      action: 'command',
      instance: 'jtl',
      command: { kind: 'ship', id: '10' },
    });
    await call('runs/test/control', {
      action: 'command',
      instance: 'shopify',
      command: { kind: 'ship', id: '10' },
    });
    const verify = createInstallationVerifier({
      simulation: options().simulation,
      jtlEndpoints: [],
    });
    for (const connection of connections)
      assert.deepEqual(
        new Set(await verify(connection, credentials)),
        new Set(connection.granted),
      );
    const runtime = createInstalledRuntime(options());
    const checks = [];
    const observe = () =>
      observeProviders({
        context: async () => context,
        installations: options().installations,
        capabilities: runtime,
        manifest: {
          connections: { jtl: connections[0].id, shopify: connections[1].id },
        },
        recordRead: async (_actor, connectionId, capability, result) =>
          checks.push({ connectionId, capability, result }),
        onError: (error) => {
          throw error;
        },
      });
    await observe();
    assert.equal(checks.length, 9);
    assert.ok(
      checks.every((check) => check.result.ok),
      JSON.stringify(checks),
    );
    for (const status of ['unavailable', 'rate-limited', 'healthy']) {
      checks.length = 0;
      await call('runs/test/control', {
        action: 'service-health',
        instance: 'jtl',
        status,
      });
      await observe();
      assert.equal(checks.length, 9);
      assert.ok(
        checks
          .filter((check) => check.connectionId === connections[1].id)
          .every((check) => check.result.ok),
      );
      assert.ok(
        checks
          .filter((check) => check.connectionId === connections[0].id)
          .every((check) => check.result.ok === (status === 'healthy')),
      );
    }
    for (const connection of connections)
      for (const capability of [
        'orders.read',
        'products.read',
        'inventory.read',
        'fulfillment.read',
      ]) {
        const result = await runtime.read(context, {
          connectionId: connection.id,
          capability,
          version: '0',
          input: { limit: 1 },
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.ok(result.value.items.length > 0);
        if (result.value.nextCursor) {
          const next = await runtime.read(context, {
            connectionId: connection.id,
            capability,
            version: '0',
            input: { limit: 1, cursor: result.value.nextCursor },
          });
          assert.equal(next.ok, true, JSON.stringify(next));
        }
      }
    await call('runs/test/control', {
      action: 'fault',
      rule: {
        instance: 'jtl',
        operation: 'orders.shipping-method.write',
        resource: '1',
        kind: 'response-loss',
        phase: 'after-commit',
      },
    });
    const effect = await createInstalledShippingMethodEffects(
      options(),
      binding,
    ).resolve(context, intent);
    await assert.rejects(
      effect.execute(intent, 'logical-key'),
      (error) =>
        error.failure.effect === 'unknown' &&
        error.failure.retry === 'reconcile',
    );
    await app.close();
    app = await createApp(join(directory, 'runs.sqlite'), token, false);
    endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    const recreated = await createInstalledShippingMethodEffects(
      options(),
      binding,
    ).resolve(context, intent);
    assert.equal((await recreated.verify(intent)).outcome, 'passed');
    const run = await call('runs/test');
    const history = await call('runs/test/journal');
    assert.equal(
      history.items.filter((e) => e.kind === 'provider-write').length,
      1,
    );
    assert.equal(run.clock.faults[0].status, 'triggered');
    assert.equal(run.jtl.orders[0].shippingMethodId, '8');
    assert.ok(observations.length > 8);
    assert.throws(() => simulationTransport(connections[0]), /unavailable/);
    assert.throws(
      () =>
        simulationTransport(
          { ...connections[0], tenantId: 'other' },
          options().simulation,
        ),
      /unavailable/,
    );
    const unbound = createSimulationTransport({ ...manifest(), bindings: [] });
    assert.throws(
      () => simulationTransport(connections[1], unbound),
      /unavailable/,
    );
    for (const kind of ['outage', 'rate-limit']) {
      await call('runs/test/control', {
        action: 'fault',
        rule: { instance: 'shopify', operation: '*', kind, phase: 'before' },
      });
      const result = await createInstalledRuntime(options()).read(context, {
        connectionId: connections[1].id,
        capability: 'orders.read',
        version: '0',
        input: { limit: 1 },
      });
      assert.equal(result.ok, false);
      assert.equal(
        result.error.code,
        kind === 'outage' ? 'transient' : 'rate_limited',
      );
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('external change between preflight and PATCH exposes the real non-atomic boundary', async () => {
  const run = createRun('race');
  const fetch = createTransport(async (request) => {
    if (request.method === 'PATCH')
      mutate(run, 'jtl', {
        kind: 'shipping-method',
        id: '1',
        shippingMethodId: '9',
      });

    return dispatch(run, 'jtl', request);
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
  assert.equal(run.jtl.orders[0].shippingMethodId, '8');
  assert.ok(
    run.clock.journal.some(
      (e) => e.kind === 'merchant' && e.detail.shippingMethodId === '9',
    ),
  );
});

test('provider contracts preserve nested pagination beyond one hundred children', async () => {
  const run = createRun('nested');
  mutate(run, 'jtl', { kind: 'ship', id: '1' });
  const firstLine = run.jtl.lines.find((line) => line.salesOrderId === '1');
  const firstNoteLine = run.jtl.noteLines[0];
  for (let index = 100; index < 201; index++) {
    run.jtl.lines.push({ ...firstLine, id: String(index), quantity: '1' });
    run.jtl.noteLines.push({
      ...firstNoteLine,
      id: String(index),
      salesOrderLineItemId: String(index),
      quantity: '1',
    });
  }
  const connector = createJtlConnector({
    tenantId,
    connectionId: 'nested',
    connection: {
      kind: 'onprem',
      baseUrl: target.baseUrl,
      appId: target.appId,
      appVersion: '1',
      challengeCode: 'synthetic',
      apiKey: async () => credentials.token,
    },
    fetch: createTransport(async (request) => dispatch(run, 'jtl', request)),
    recordObservations: async () => {},
  });
  const runtime = createCapabilityRuntime({
    resolve: async () => connector,
    record: async () => {},
  });
  const result = await runtime.read(context, {
    connectionId: 'nested',
    capability: 'fulfillment.read',
    version: '0',
    input: { limit: 1 },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.items[0].data.lines.length, 102);
  assert.equal(
    run.clock.journal.filter(
      (e) =>
        e.kind === 'request' &&
        e.detail.url.includes('delivery-notes/1/line-items'),
    ).length,
    2,
  );
});

test('Shopify reads retain total quantity and completed work separately from shipment', async () => {
  const run = createRun('shopify-shipping', 44, 'manual');
  const connector = createShopifyConnector({
    tenantId,
    connectionId: 'shopify-shipping',
    shop: 'test.myshopify.com',
    accessToken: async () => 'synthetic',
    fetch: createTransport(async (request) =>
      dispatch(run, 'shopify', request),
    ),
    recordObservations: async () => {},
  });
  const runtime = createCapabilityRuntime({
    resolve: async () => connector,
    record: async () => {},
  });
  const read = async () => {
    const result = await runtime.read(context, {
      connectionId: 'shopify-shipping',
      capability: 'fulfillment.read',
      version: '0',
      input: { limit: 100 },
    });
    assert.equal(result.ok, true, JSON.stringify(result));

    return result.value.items;
  };
  const workId = 'gid://shopify/FulfillmentOrder/1';
  const before = (await read()).find(
    (item) => item.source.externalId === workId,
  );
  assert.equal(before.data.status, 'pending');
  advanceRun(run, 1000);
  mutate(run, 'shopify', { kind: 'ship', id: '1' });
  const after = await read();
  const closed = after.find((item) => item.source.externalId === workId);
  assert.ok(closed);
  assert.ok(closed.sourceUpdatedAt > before.sourceUpdatedAt);
  assert.equal(closed.data.status, 'completed');
  assert.equal(closed.data.lines[0].quantity.amount, '2');
  assert.equal(
    run.shopify.nodes['gid://shopify/FulfillmentOrderLineItem/1']
      .remainingQuantity,
    0,
  );
  assert.ok(after.some((item) => item.data.status === 'shipped'));
});
