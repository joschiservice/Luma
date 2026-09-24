import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, it } from 'vitest';

import { createApp } from './app.js';
import { advanceRun, createRun, dispatch, mutate } from './run.js';

it('reproduces seeded cross-provider propagation with explicit delay', () => {
  const a = createRun('a');
  const b = createRun('a');
  advanceRun(a, 10000);
  expect(a.shopify.roots.orders).toHaveLength(3);
  expect(a.jtl.orders).toHaveLength(2);
  advanceRun(a, 25000);
  advanceRun(b, 35000);
  expect(a).toEqual(b);
  expect(a.jtl.notes).toHaveLength(1);
});

it('persists a committed write and consumed fault across restart, with isolated runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-simulator-'));
  const token = 'test-synthetic-simulator-token';
  const path = join(directory, 'runs.sqlite');
  let app = await createApp(path, token, false);
  const post = async (url: string, payload: unknown) => {
    const result = await app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(payload),
    });
    expect(result.statusCode, result.body).toBe(200);

    return result.json();
  };
  try {
    for (const id of ['a', 'b']) await post('/api/runs', { id });
    await post('/api/runs/a/control', {
      action: 'fault',
      rule: {
        instance: 'jtl',
        operation: 'orders.shipping-method.write',
        kind: 'response-loss',
        phase: 'after-commit',
      },
    });
    const request = {
      url: 'https://jtl.invalid/api/sales-orders/1',
      method: 'PATCH',
      headers: { authorization: 'Wawi synthetic' },
      body: '{"shippingMethodId":"8"}',
    };
    expect(
      await post('/api/runs/a/providers/jtl/request', request),
    ).toMatchObject({ lost: true });
    await post('/api/runs/a/control', {
      action: 'advance',
      milliseconds: 35000,
    });
    await app.close();
    app = await createApp(path, token, false);
    const runs = (
      await app.inject({
        url: '/api/runs',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    expect(runs[0].jtl.orders[0].shippingMethodId).toBe('8');
    expect(runs[1].jtl.orders[0].shippingMethodId).toBe('7');
    expect(runs[0].clock.faults[0].status).toBe('triggered');
    expect(runs[0].jtl.notes).toHaveLength(1);
    expect(
      await post('/api/runs/a/providers/jtl/request', request),
    ).not.toHaveProperty('lost');
    await post('/api/runs/a/control', { action: 'advance', milliseconds: 1 });
    const again = (
      await app.inject({
        url: '/api/runs',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    expect(again[0].jtl.notes).toHaveLength(1);
    expect((await app.inject({ url: '/api/runs' })).statusCode).toBe(401);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('authenticates matched API routes even when their paths are encoded', async () => {
  const token = 'test-synthetic-simulator-token';
  const app = await createApp(':memory:', token, false);
  try {
    for (const prefix of ['/api', '/%61pi', '/a%70i']) {
      for (const [method, path, payload] of [
        ['GET', '/runs', undefined],
        ['POST', '/runs', { id: 'unauthorized' }],
        ['POST', '/runs/unauthorized/control', { action: 'resume' }],
        ['POST', '/runs/unauthorized/providers/jtl/request', {}],
      ] as const) {
        const response = await app.inject({
          method,
          url: prefix + path,
          ...(payload ? { payload } : {}),
        });
        expect(response.statusCode).toBe(401);
      }
    }
    const response = await app.inject({
      url: '/%61pi/runs',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect((await app.inject({ url: '/' })).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});

it.each([
  ['fulfillment.read', 'delivery-notes/1'],
  ['fulfillment.read', 'delivery-notes/1/line-items?pageNumber=2'],
  ['items.read', 'warehouses/1/items/1/stocks'],
])('targets %s faults to the resource in %s', (operation, path) => {
  const run = createRun('targeted');
  mutate(run, 'jtl', { kind: 'ship', id: '1' });
  run.clock.faults.push({
    id: 'targeted',
    instance: 'jtl',
    operation,
    resource: '1',
    phase: 'before',
    kind: 'outage',
    occurrence: 1,
    remaining: 1,
    matches: 0,
    status: 'armed',
  });
  const request = (suffix: string) =>
    dispatch(run, 'jtl', {
      url: 'https://jtl.invalid/api/' + suffix,
      method: 'GET',
      headers: { authorization: 'Wawi synthetic' },
      body: null,
    });
  request(path.replaceAll('/1', '/2'));
  expect(run.clock.faults[0]!.matches).toBe(0);
  expect(request(path).status).toBe(503);
  expect(run.clock.faults[0]!.status).toBe('triggered');
});

it.each(['jtl', 'shopify'] as const)(
  'keeps %s health persistent, isolated and recoverable',
  async (instance) => {
    const directory = await mkdtemp(join(tmpdir(), 'luma-health-'));
    const path = join(directory, 'runs.sqlite');
    const token = 'test-synthetic-simulator-token';
    let app = await createApp(path, token, false);
    const post = async (
      url: string,
      payload: unknown,
      expectedStatus = 200,
    ) => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify(payload),
      });
      expect(response.statusCode, response.body).toBe(expectedStatus);

      return response.json();
    };
    const request =
      instance === 'jtl'
        ? {
            url: 'https://jtl.invalid/api/sales-orders/1',
            method: 'PATCH',
            headers: { authorization: 'Wawi synthetic' },
            body: '{"shippingMethodId":"8"}',
          }
        : {
            url: 'https://shopify.invalid/admin/api/2026-07/graphql.json',
            method: 'POST',
            headers: { 'x-shopify-access-token': 'synthetic' },
            body: JSON.stringify({
              query:
                'query LumaPage { page: orders(first: $first) { nodes { id } } }',
              variables: { first: 10 },
            }),
          };
    try {
      for (const id of ['a', 'b'])
        await post('/api/runs', { id, scenario: 'manual' });
      await post(
        '/api/runs/a/control',
        { action: 'service-health', instance, status: 'broken' },
        400,
      );
      await post(
        '/api/runs/a/control',
        { action: 'service-health', instance: 'unknown', status: 'healthy' },
        400,
      );
      await post('/api/runs/a/control', {
        action: 'fault',
        rule: { instance, operation: '*', phase: 'before', kind: 'outage' },
      });
      for (const [status, code] of [
        ['rate-limited', 429],
        ['unavailable', 503],
      ] as const) {
        const run = await post('/api/runs/a/control', {
          action: 'service-health',
          instance,
          status,
        });
        expect(run.serviceHealth[instance]).toBe(status);
        await app.close();
        app = await createApp(path, token, false);
        await post('/api/runs/a/control', {
          action: 'advance',
          milliseconds: 86400000,
        });
        for (let i = 0; i < 3; i++) {
          expect(
            await post(`/api/runs/a/providers/${instance}/request`, request),
          ).toMatchObject({ status: code, headers: { 'retry-after': '1' } });
        }
        expect(
          await post(`/api/runs/b/providers/${instance}/request`, request),
        ).toMatchObject({ status: 200 });
      }
      const run = await post('/api/runs/a/control', {
        action: 'service-health',
        instance,
        status: 'healthy',
      });
      expect(run.jtl.orders[0].shippingMethodId).toBe('7');
      expect(run.serviceHealth).toEqual({ jtl: 'healthy', shopify: 'healthy' });
      expect(run.clock.faults[0]).toMatchObject({
        status: 'armed',
        matches: 0,
        remaining: 1,
      });
      expect(
        run.clock.journal.filter(
          (event: { kind: string }) => event.kind === 'response',
        ),
      ).toHaveLength(6);
      expect(
        await post(`/api/runs/a/providers/${instance}/request`, request),
      ).toMatchObject({ status: 503 });
      expect(
        await post(`/api/runs/a/providers/${instance}/request`, request),
      ).toMatchObject({ status: 200 });
      await post('/api/runs/a/control', {
        action: 'service-health',
        instance,
        status: 'unavailable',
      });
      const reset = await post('/api/runs/a/control', { action: 'reset' });
      expect(reset.serviceHealth).toEqual({
        jtl: 'healthy',
        shopify: 'healthy',
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('loads older saved runs with healthy providers and an isolated scenario stock pool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-health-upgrade-'));
  const path = join(directory, 'runs.sqlite');
  const token = 'test-synthetic-simulator-token';
  const database = new DatabaseSync(path);
  const legacy: Partial<ReturnType<typeof createRun>> = createRun('legacy');
  delete legacy.serviceHealth;
  delete legacy.operationalScenarios;
  legacy.jtl!.items = legacy.jtl!.items.filter((item) => item.id !== '2');
  for (const key of Object.keys(legacy.shopify!.nodes))
    if (key.endsWith('/2')) delete legacy.shopify!.nodes[key];
  for (const key of Object.keys(legacy.shopify!.children))
    if (key.endsWith('/2')) delete legacy.shopify!.children[key];
  for (const root of ['products', 'inventoryItems'] as const)
    legacy.shopify!.roots[root] = legacy.shopify!.roots[root].filter(
      (key) => !key.endsWith('/2'),
    );
  database.exec(
    'CREATE TABLE simulator_state (id INTEGER PRIMARY KEY, document TEXT NOT NULL)',
  );
  database
    .prepare('INSERT INTO simulator_state VALUES (1, ?)')
    .run(JSON.stringify({ legacy }));
  database.close();
  const app = await createApp(path, token, false);
  try {
    const response = await app.inject({
      url: '/api/runs',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()[0].serviceHealth).toEqual({
      jtl: 'healthy',
      shopify: 'healthy',
    });
    expect(response.json()[0].operationalScenarios).toEqual([]);
    expect(response.json()[0].jtl.items).toContainEqual(
      expect.objectContaining({ id: '2', stockAvailable: '100' }),
    );
    expect(response.json()[0].shopify.roots.inventoryItems).toContain(
      'gid://shopify/InventoryItem/2',
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
