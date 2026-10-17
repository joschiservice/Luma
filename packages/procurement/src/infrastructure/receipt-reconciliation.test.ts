import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { commitmentFixture as fixture } from './commitments.fixture.js';

describe('receipt reconciliation commands', () => {
  it('stores good and damaged quantities atomically, keeps evidence and returns exact retries', async () => {
    const f = fixture();
    const body = f.request();
    const recorded = await f.service.recordReceipt(
      f.context(),
      f.order.id,
      body,
    );
    expect(recorded.source).toMatchObject({
      kind: 'manual_receipt',
      reason: body.reason,
      evidence: body.evidence,
    });
    expect(f.commitments.map((c) => [c.kind, c.quantity])).toEqual([
      ['received', 40],
      ['damaged', 2],
    ]);
    expect(
      await f.service.recordReceipt(f.context(), f.order.id, body),
    ).toEqual(recorded);
    expect(f.commitments).toHaveLength(2);
    expect(f.audits).toHaveLength(1);
    await expect(
      f.service.recordReceipt(f.context(), f.order.id, {
        ...body,
        quantity: 41,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      f.service.recordReceipt(f.context(), f.order.id, {
        ...body,
        id: randomUUID(),
        quantity: 41,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('refuses receipt owned by a purchasing system and enforces the rollout flag', async () => {
    const f = fixture();
    f.supplier.link = {
      connectionId: randomUUID(),
      externalId: 'supplier',
      scopeKey: '',
      name: null,
      linkedBy: 'buyer',
      linkedAt: f.supplier.createdAt,
    };
    await expect(
      f.service.recordReceipt(f.context(), f.order.id, f.request()),
    ).rejects.toMatchObject({ statusCode: 409 });
    f.supplier.link = null;
    f.enable(false);
    await expect(
      f.service.recordReceipt(f.context(), f.order.id, f.request()),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(f.commitments).toHaveLength(0);
  });
  it('does not write across tenants and rejects damage above the total receipt', async () => {
    const f = fixture();
    await expect(
      f.service.recordReceipt(f.context(randomUUID()), f.order.id, f.request()),
    ).rejects.toThrow('Tenant has no records');
    await expect(
      f.service.recordReceipt(f.context(), f.order.id, {
        ...f.request(),
        damagedQuantity: 41,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.commitments).toHaveLength(0);
  });
  it('serializes conflicting decisions and makes waiting reappear at its deadline', async () => {
    const f = fixture();
    await f.service.recordReceipt(f.context(), f.order.id, f.request());
    const damage = f.commitments.find((c) => c.kind === 'damaged')!;
    const body = {
      id: randomUUID(),
      key: `receipt_difference:${damage.id}`,
      response: 'following_up',
      note: 'Supplier reviewing damage',
      nextCheckAt: '2026-10-04T09:00:00.000Z',
    };
    const results = await Promise.allSettled([
      f.service.respond(f.context(), f.order.id, body),
      f.service.respond(f.context(undefined, randomUUID()), f.order.id, {
        ...body,
        id: randomUUID(),
        response: 'written_off',
        note: 'Discarded',
        nextCheckAt: null,
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(f.followUps).toHaveLength(1);
    expect(await f.service.respond(f.context(), f.order.id, body)).toEqual(
      f.followUps[0],
    );
    f.now('2026-10-04T10:00:00.000Z');
    const record = await f.service.order(f.context(), f.order.id);
    expect(record.progress.attention).toContainEqual(
      expect.objectContaining({
        kind: 'receipt_difference',
        key: `${body.key}:${body.nextCheckAt}`,
      }),
    );
  });
});
