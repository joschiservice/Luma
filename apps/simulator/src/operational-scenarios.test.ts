import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stock } from '@luma/simulator-shopify';
import { expect, it } from 'vitest';

import { createApp } from './app.js';
import {
  injectInventoryMismatch,
  recoverInventoryMismatch,
} from './operational-scenarios.js';
import { createRun, mutate } from './run.js';

it('recovers to current authoritative availability without losing reservations or replaying old commands', () => {
  const run = createRun('inventory', 44, 'manual');
  const id = randomUUID();
  const quantities = run.shopify.nodes['gid://shopify/InventoryLevel/2']!
    .quantities as { name: string; quantity: number }[];
  quantities.find((item) => item.name === 'committed')!.quantity = 3;
  quantities.find((item) => item.name === 'available')!.quantity = 97;
  injectInventoryMismatch(run, id);
  expect(stock(run.shopify, '2')).toEqual({
    onHand: 113,
    available: 110,
    reserved: 3,
  });
  expect(() => injectInventoryMismatch(run, randomUUID())).toThrow(
    'Match stock',
  );
  mutate(run, 'jtl', { kind: 'order', id: '100', quantity: 5 });
  mutate(run, 'jtl', { kind: 'stock', id: '2', quantity: 90 });
  recoverInventoryMismatch(run, id);
  expect(stock(run.shopify, '2')).toEqual({
    onHand: 93,
    available: 90,
    reserved: 3,
  });
  const before = structuredClone(run);
  injectInventoryMismatch(run, id);
  recoverInventoryMismatch(run, id);
  expect(run).toEqual(before);
  const next = randomUUID();
  injectInventoryMismatch(run, next);
  recoverInventoryMismatch(run, id);
  expect(stock(run.shopify, '2').available).toBe(100);
});

it('persists scenario idempotency across a restart and isolates runs through the control API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-operational-'));
  const path = join(directory, 'runs.sqlite');
  const token = 'operational-test-simulator-token';
  let app = await createApp(path, token, false);
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      payload: JSON.stringify(payload),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    });
  try {
    await post('/api/runs', { id: 'one', scenario: 'manual' });
    await post('/api/runs', { id: 'two', scenario: 'manual' });
    const id = randomUUID();
    const payload = { id, kind: 'inventory-mismatch' };
    const response = await post('/api/runs/one/scenarios', payload);
    expect(response.statusCode).toBe(200);
    await app.close();
    app = await createApp(path, token, false);
    expect((await post('/api/runs/one/scenarios', payload)).json()).toEqual(
      response.json(),
    );
    expect(
      (await post('/api/runs/two/scenarios/' + id + '/recover', {})).statusCode,
    ).toBe(409);
    const runs = (
      await app.inject({
        url: '/api/runs',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    expect(runs[0].operationalScenarios).toHaveLength(1);
    expect(runs[1].operationalScenarios).toHaveLength(0);
    expect(
      (
        await post('/api/runs/one/scenarios', {
          id: 'invalid',
          kind: 'inventory-mismatch',
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
