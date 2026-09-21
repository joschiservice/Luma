import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
