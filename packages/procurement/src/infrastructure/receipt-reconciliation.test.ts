import { randomUUID } from 'node:crypto';

import type { ModelGateway } from '@luma/platform';
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

describe('supplier messages from the inbox', () => {
  /** A model that confirms the ordered quantity, which would count without review. */
  const confirming: ModelGateway = {
    generate: (async (_trace, request) => ({
      output: request.output!.parse({
        relatesToOrder: true,
        facts: [
          {
            kind: 'confirmed_quantity',
            lineId: null,
            quantity: 100,
            date: null,
            text: null,
            quote: 'confirm 100 units',
            confident: true,
          },
        ],
      }),
      toolCalls: [],
      metadata: {
        adapter: 'bedrock' as const,
        model: 'eu.model',
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: null,
      },
    })) as ModelGateway['generate'],
  };
  const message = () => ({
    id: randomUUID(),
    channel: 'email' as const,
    from: 'sales@supplier.example',
    subject: 'Re: PO-1',
    body: 'We confirm 100 units, on time.',
    receivedAt: '2026-10-02T10:00:00.000Z',
    messageId: `${randomUUID()}@supplier.example`,
  });

  it('holds facts from an unauthenticated sender for review instead of confirming them', async () => {
    const f = fixture(confirming);
    await f.service.recordMessage(f.context(), f.order.id, message(), {
      senderVerified: false,
    });
    expect(f.commitments).toEqual([
      expect.objectContaining({
        kind: 'confirmed_quantity',
        quantity: 100,
        status: 'needs_review',
        reviewReasons: ['sender_unverified'],
      }),
    ]);
  });

  it('confirms matching facts from an authenticated sender or a message a person recorded', async () => {
    const f = fixture(confirming);
    await f.service.recordMessage(f.context(), f.order.id, message(), {
      senderVerified: true,
    });
    await f.service.recordMessage(f.context(), f.order.id, message());
    expect(f.commitments.map((c) => [c.status, c.reviewReasons])).toEqual([
      ['confirmed', []],
      ['confirmed', []],
    ]);
  });

  /** Which message each extracted commitment came from, with its status. */
  const outcomes = (f: ReturnType<typeof fixture>) =>
    f.commitments.map((c) => [
      c.source.kind === 'communication' ? c.source.communicationId : null,
      c.status,
    ]);

  it('lets a genuine message through after a forged one claimed its Message-ID', async () => {
    const f = fixture(confirming);
    const genuine = message();
    const forged = {
      ...genuine,
      id: randomUUID(),
      body: 'We confirm 100 units, delivery moved to December.',
    };
    expect(
      await f.service.recordMessage(f.context(), f.order.id, forged, {
        senderVerified: false,
      }),
    ).toEqual({ communicationId: forged.id, duplicate: false });
    expect(
      await f.service.recordMessage(f.context(), f.order.id, genuine, {
        senderVerified: true,
      }),
    ).toEqual({ communicationId: genuine.id, duplicate: false });
    expect(outcomes(f)).toEqual([
      [forged.id, 'needs_review'],
      [genuine.id, 'confirmed'],
    ]);
  });

  it('keeps a genuine message when a forged one with its Message-ID arrives later', async () => {
    const f = fixture(confirming);
    const genuine = message();
    await f.service.recordMessage(f.context(), f.order.id, genuine, {
      senderVerified: true,
    });
    const forged = {
      ...genuine,
      id: randomUUID(),
      body: 'We confirm 100 units, delivery moved to December.',
    };
    expect(
      await f.service.recordMessage(f.context(), f.order.id, forged, {
        senderVerified: false,
      }),
    ).toEqual({ communicationId: forged.id, duplicate: false });
    // An unverified copy with the same text adds nothing.
    expect(
      await f.service.recordMessage(
        f.context(),
        f.order.id,
        { ...genuine, id: randomUUID() },
        { senderVerified: false },
      ),
    ).toEqual({ communicationId: genuine.id, duplicate: true });
    expect(outcomes(f)).toEqual([
      [genuine.id, 'confirmed'],
      [forged.id, 'needs_review'],
    ]);
  });
});
