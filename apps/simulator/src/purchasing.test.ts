import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { advanceRun, createRun, dispatch, faultSchema, mutate } from './run.js';
import { openStore } from './store.js';

const wallTime = Date.parse('2026-10-01T10:00:00Z');

const body = (quantity = 10) => ({
  supplierId: '1',
  requestedDeliveryDate: '2026-10-12T12:00:00Z',
  items: [
    {
      itemId: '1',
      quantity,
      netPurchasePriceAmount: 9.5,
      vatRatePercentage: 19,
    },
  ],
  internalComment: 'Created by Luma · luma-po:po-1',
});

const post = (key: string, quantity?: number) => ({
  url: 'https://jtl.invalid/api/eazybusiness/purchase-orders',
  method: 'POST',
  headers: { authorization: 'Wawi synthetic', 'idempotency-key': key },
  body: JSON.stringify(body(quantity)),
});

describe('simulated supplier answers', () => {
  it('confirms and books goods receipt into JTL stock under the default profile', () => {
    const run = createRun('purchasing', 44, 'manual');
    const stock = Number(run.jtl.items[0]!.stockTotal);
    expect(dispatch(run, 'jtl', post('k'), wallTime)).toMatchObject({
      status: 201,
      body: { purchaseOrderId: '1' },
    });
    expect(run.jtl.purchaseOrders[0]!.createdAt).toBe(
      '2026-10-01T10:00:00.000Z',
    );
    // A replayed key neither creates nor schedules again.
    dispatch(run, 'jtl', post('k'), wallTime);
    expect(run.clock.events).toHaveLength(2);
    advanceRun(run, 20000);
    expect(run.jtl.purchaseOrders[0]).toMatchObject({
      isConfirmed: true,
      status: 0,
      lineItems: [
        {
          confirmedQuantity: 10,
          confirmedDeliveryDate: '2026-10-12T00:00:00Z',
        },
      ],
    });
    advanceRun(run, 40000);
    expect(run.jtl.purchaseOrders[0]).toMatchObject({
      status: 500,
      lineItems: [{ deliveredQuantity: 10, openQuantity: 0 }],
    });
    expect(Number(run.jtl.items[0]!.stockTotal)).toBe(stock + 10);
    expect(run.jtl.purchaseOrders).toHaveLength(1);
  });

  it('follows the supplier profile chosen before the order is placed', () => {
    const run = createRun('profiles', 44, 'manual');
    mutate(run, 'jtl', {
      kind: 'supplier-profile',
      supplierId: '1',
      profile: 'partial',
    });
    dispatch(run, 'jtl', post('partial'), wallTime);
    mutate(run, 'jtl', {
      kind: 'supplier-profile',
      supplierId: '1',
      profile: 'silent',
    });
    dispatch(run, 'jtl', post('silent'), wallTime);
    advanceRun(run, 100000);
    expect(run.jtl.purchaseOrders[0]).toMatchObject({
      status: 30,
      lineItems: [
        {
          confirmedQuantity: 6,
          confirmedDeliveryDate: '2026-10-15T00:00:00Z',
          deliveredQuantity: 6,
          openQuantity: 4,
        },
      ],
    });
    expect(run.jtl.purchaseOrders[1]).toMatchObject({
      status: 0,
      isConfirmed: false,
      lineItems: [{ confirmedQuantity: null, deliveredQuantity: 0 }],
    });
    expect(() =>
      mutate(run, 'shopify', {
        kind: 'supplier-profile',
        supplierId: '1',
        profile: 'full',
      }),
    ).toThrow('not simulated');
    expect(() =>
      mutate(run, 'jtl', {
        kind: 'supplier-profile',
        supplierId: '1',
        profile: 'eager',
      }),
    ).toThrow();
  });

  it('skips supplier answers the merchant has already booked', () => {
    const run = createRun('booked', 44, 'manual');
    dispatch(run, 'jtl', post('k', 4), wallTime);
    mutate(run, 'jtl', {
      kind: 'purchase-order-receive',
      orderId: '1',
      lines: [{ lineItemId: '1001', quantity: 4 }],
    });
    advanceRun(run, 60000);
    expect(run.jtl.purchaseOrders[0]).toMatchObject({
      status: 500,
      isConfirmed: false,
      lineItems: [{ deliveredQuantity: 4 }],
    });
    expect(run.clock.running).toBe(false);
  });

  it('allows response loss after a committed purchase-order create', () => {
    expect(
      faultSchema.safeParse({
        instance: 'jtl',
        operation: 'purchase-orders.submit',
        kind: 'response-loss',
        phase: 'after-commit',
      }).success,
    ).toBe(true);
    expect(
      faultSchema.safeParse({
        instance: 'jtl',
        operation: 'purchase-orders.read',
        kind: 'response-loss',
        phase: 'after-commit',
      }).success,
    ).toBe(false);
  });
});

describe('purchasing control API', () => {
  const token = 'test-synthetic-simulator-token';
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('drives deterministic transitions, loses a committed response and keeps state on restart', async () => {
    directory = await mkdtemp(join(tmpdir(), 'luma-purchasing-'));
    const path = join(directory, 'runs.sqlite');
    let app = await createApp(path, token, false);
    const call = async (url: string, payload: unknown, status = 200) => {
      const result = await app.inject({
        method: 'POST',
        url,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify(payload),
      });
      expect(result.statusCode, result.body).toBe(status);

      return result.json();
    };
    try {
      await call('/api/runs', { id: 'a', scenario: 'manual' });
      await call('/api/runs/a/control', {
        action: 'command',
        instance: 'jtl',
        command: {
          kind: 'supplier-profile',
          supplierId: '1',
          profile: 'silent',
        },
      });
      await call('/api/runs/a/control', {
        action: 'fault',
        rule: {
          instance: 'jtl',
          operation: 'purchase-orders.submit',
          kind: 'response-loss',
          phase: 'after-commit',
        },
      });
      expect(
        await call('/api/runs/a/providers/jtl/request', post('lost')),
      ).toMatchObject({ lost: true });
      expect(
        await call('/api/runs/a/providers/jtl/request', post('lost')),
      ).toMatchObject({ status: 201, body: { purchaseOrderId: '1' } });
      await call('/api/runs/a/control', {
        action: 'command',
        instance: 'jtl',
        command: {
          kind: 'purchase-order-confirm',
          orderId: '1',
          lines: [
            { lineItemId: '1001', quantity: 10, deliveryDate: '2026-10-20' },
          ],
        },
      });
      await call('/api/runs/a/control', {
        action: 'command',
        instance: 'jtl',
        command: {
          kind: 'purchase-order-receive',
          orderId: '1',
          lines: [{ lineItemId: '1001', quantity: 3 }],
        },
      });
      await call(
        '/api/runs/a/control',
        {
          action: 'command',
          instance: 'jtl',
          command: {
            kind: 'purchase-order-receive',
            orderId: '1',
            lines: [{ lineItemId: '1001', quantity: 30 }],
          },
        },
        409,
      );
      await app.close();
      app = await createApp(path, token, false);
      const run = (
        await app.inject({
          url: '/api/runs/a',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json();
      expect(run.jtl.supplierProfiles).toEqual({ '1': 'silent' });
      expect(run.jtl.purchaseOrders).toHaveLength(1);
      expect(run.jtl.purchaseOrders[0]).toMatchObject({
        isConfirmed: true,
        status: 30,
        lineItems: [{ deliveredQuantity: 3, openQuantity: 7 }],
      });
      expect(run.clock.events).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('backfills purchasing for runs saved before it was simulated', async () => {
    directory = await mkdtemp(join(tmpdir(), 'luma-purchasing-legacy-'));
    const path = join(directory, 'runs.sqlite');
    const store = await openStore(path);
    await store.transact((runs) => {
      const legacy = createRun('legacy') as unknown as {
        jtl: Record<string, unknown>;
      };
      for (const key of [
        'suppliers',
        'itemSuppliers',
        'purchaseOrders',
        'purchaseOrderKeys',
        'supplierProfiles',
      ])
        delete legacy.jtl[key];
      runs.legacy = legacy as unknown as ReturnType<typeof createRun>;
    });
    await store.close();
    const app = await createApp(path, token, false);
    try {
      const run = (
        await app.inject({
          url: '/api/runs/legacy',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json();
      expect(run.jtl).toMatchObject({
        suppliers: [
          { id: '1', companyName: 'Nordwind Textil GmbH' },
          { id: '2', companyName: 'Baltic Packaging AB' },
        ],
        purchaseOrders: [],
        supplierProfiles: {},
      });
    } finally {
      await app.close();
    }
  });
});
