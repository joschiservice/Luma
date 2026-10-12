import { randomUUID } from 'node:crypto';

import type { InvocationContext } from '@luma/connections';
import { describe, expect, it, vi } from 'vitest';

import { createJtlSettlementCapabilities } from './return-settlement.js';

const operationId = randomUUID();
const input = {
  kind: 'restock',
  item: { externalId: '2', scopeKey: '' },
  warehouse: { externalId: '1', scopeKey: '' },
  quantity: 1,
};
const context = {
  tenant: { tenantId: 'tenant-a' },
  connectionId: 'wawi',
  provider: 'jtl',
  idempotencyKey: operationId,
} as InvocationContext;

function fixture() {
  let total = 10,
    rows: unknown[] = [],
    lost = false,
    writes = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/items/2'))
      return Response.json({
        id: '2',
        sKU: 'TOTE',
        isActive: true,
        isInventoryManagementActive: true,
      });
    if (path.endsWith('/warehouses/1'))
      return Response.json({ id: '1', active: true, name: 'Hamburg' });
    if (path.endsWith('/stocks/changes'))
      return Response.json({
        items: rows,
        totalItems: rows.length,
        pageNumber: 1,
        pageSize: 100,
      });
    if (path.endsWith('/stocks') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        itemId: '2',
        warehouseId: '1',
        quantity: 1,
        comment: `luma-rs:${operationId}`,
      });
      writes++;
      total++;
      rows = [
        {
          itemId: '2',
          warehouseId: '1',
          quantity: 1,
          changedDate: new Date().toISOString(),
          comment: `luma-rs:${operationId}`,
        },
      ];
      if (lost) throw new Error('Response lost after stock commit');

      return Response.json(
        { itemId: '2', warehouseId: '1', quantityTotal: total },
        { status: 201 },
      );
    }

    return Response.json({ totalQuantity: total, lockedQuantity: 0 });
  });
  const caps = createJtlSettlementCapabilities({
    tenantId: 'tenant-a',
    connectionId: 'wawi',
    connection: {
      kind: 'onprem',
      baseUrl: 'https://test.example/erp/v2/',
      appId: 'Luma',
      appVersion: '1',
      challengeCode: 'test',
      apiKey: async () => 'token',
    },
    fetch,
    settlementActions: true,
    recordObservations: vi.fn(async () => undefined),
    readRetry: { attempts: 1, maxDelayMs: 0, sleep: async () => undefined },
  });
  const quote = () =>
    caps['returns.settlement.quote.read']!.run(
      context,
      caps['returns.settlement.quote.read']!.parseInput(input),
    );
  const proof = (plan: unknown) =>
    caps['returns.settlement.proof.read']!.run(
      context,
      caps['returns.settlement.proof.read']!.parseInput({ operationId, plan }),
    );
  const send = (plan: unknown, invocation = context) =>
    caps['returns.restock']!.run(
      invocation,
      caps['returns.restock']!.parseInput({ operationId, plan }),
    );

  return {
    quote,
    proof,
    send,
    fetch,
    writes: () => writes,
    lose: () => {
      lost = true;
    },
    movement: () => {
      total++;
    },
  };
}

describe('Wawi resale settlement', () => {
  it('reconciles a lost response and refuses replay without assuming provider idempotency', async () => {
    const f = fixture(),
      q = await f.quote();
    f.lose();
    await expect(f.send(q.plan)).rejects.toBeDefined();
    expect(await f.proof(q.plan)).toMatchObject({
      outcome: 'passed',
      payment: null,
    });
    await expect(f.send(q.plan)).rejects.toMatchObject({
      failure: { dispatch: 'not_dispatched' },
    });
    expect(f.writes()).toBe(1);
    f.movement();
    expect(await f.proof(q.plan)).toMatchObject({ outcome: 'inconclusive' });
  });
  it('rejects other tenant access before reading or writing stock', async () => {
    const f = fixture(),
      q = await f.quote();
    f.fetch.mockClear();
    await expect(
      f.send(q.plan, {
        ...context,
        tenant: { ...context.tenant, tenantId: 'tenant-b' },
      }),
    ).rejects.toMatchObject({ failure: { dispatch: 'not_dispatched' } });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
