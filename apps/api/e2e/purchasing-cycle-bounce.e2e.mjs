import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { until } from './helpers.mjs';
import { purchasingCycleFixture } from './purchasing-cycle-fixture.mjs';

it('settles an order email made uncertain by a forged bounce through a person’s decision or the supplier’s authenticated reply', async (t) => {
  const f = await purchasingCycleFixture(t, 'email', {
    imported: true,
    ignoreAlternative: true,
  });
  const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  await f.api('/messaging/mailboxes');
  const company = {
    name: 'Cycle Commerce GmbH',
    address: 'Hauptstraße 1\n10115 Berlin',
    registration: 'Reviewed company identity',
  };
  /** Drafts, approves and sends the order email; the mail provider verifies the send. */
  const send = async () => {
    const draft = await f.api(
      `/procurement/purchase-orders/${f.orderId}/email/submission`,
      {
        id: randomUUID(),
        connectionId: f.f.manifest.connections.gmail,
        requestedDeliveryDate: date,
        company,
      },
    );
    const requested = await f.api(`/messaging/outbound/${draft.id}/request`, {
      id: randomUUID(),
    });
    const sent = await f.api(
      `/messaging/outbound/${draft.id}/decision`,
      { decisionId: requested.decisionId, outcome: 'approved' },
      { cookie: f.approver() },
    );
    expect(sent.state).toBe('sent');

    return draft;
  };
  /** Delivers a bounce whose sender Gmail could not authenticate, and reads it from the thread. */
  const forgedBounce = async (outboundId) => {
    await f.command('gmail', {
      kind: 'bounce',
      message: `luma.${outboundId}@luma-goods.example`,
      recipient: f.supplier.email,
      status: '5.1.1',
      authentication: 'fail',
    });
    await readThreadAgain(outboundId);
    const outbound = await f.api(`/messaging/outbound/${outboundId}/check`, {
      id: randomUUID(),
    });
    expect(outbound).toMatchObject({
      state: 'uncertain',
      canResolveDelivery: true,
      delivery: {
        report: { recipient: f.supplier.email, status: '5.1.1' },
        resolution: null,
      },
    });
    expect((await f.record()).submission).toMatchObject({
      channel: 'email',
      state: 'uncertain',
    });

    return outbound;
  };
  // Bounces don't match the mailbox rules; the supplier mail pass rereads the send's thread.
  const readThreadAgain = async (outboundId) => {
    await f.f.db.owner.query(
      `UPDATE messaging_outbound SET document=jsonb_set(document,'{deliveryCheckedAt}','"2026-01-01T00:00:00Z"')
       WHERE tenant_id=$1 AND id=$2`,
      [f.org, outboundId],
    );
    await f.readMail();
  };

  const first = await send();
  const uncertain = await forgedBounce(first.id);
  // Luma never prompts a second order email on a forged report.
  await f.api(
    `/procurement/purchase-orders/${f.orderId}/email/submission`,
    {
      id: randomUUID(),
      connectionId: f.f.manifest.connections.gmail,
      requestedDeliveryDate: date,
      company,
    },
    { status: 409 },
  );
  // An unauthenticated "reply" from the supplier's address proves nothing.
  await f.command('gmail', {
    kind: 'deliver',
    from: { address: f.supplier.email },
    threadOf: `luma.${first.id}@luma-goods.example`,
    text: 'Received, thanks.',
    messageId: `forged-reply-${randomUUID()}@cycle-supplier.example`,
    authentication: 'fail',
  });
  await readThreadAgain(first.id);
  const stillUncertain = await f.api(`/messaging/outbound/${first.id}/check`, {
    id: randomUUID(),
  });
  expect(stillUncertain.state).toBe('uncertain');

  // The approver asked the supplier: nothing arrived.
  const decision = {
    id: randomUUID(),
    expectedRevision: stillUncertain.revision,
    outcome: 'not_delivered',
    note: 'Called the supplier; the order did not arrive.',
  };
  const resolved = await f.api(
    `/messaging/outbound/${first.id}/delivery`,
    decision,
    { cookie: f.approver() },
  );
  expect(resolved).toMatchObject({
    state: 'failed',
    delivery: {
      resolution: {
        outcome: 'not_delivered',
        source: 'person',
        note: decision.note,
      },
    },
  });
  expect(uncertain.revision).toBeLessThan(resolved.revision);
  expect(
    await f.api(`/messaging/outbound/${first.id}/delivery`, decision, {
      cookie: f.approver(),
    }),
  ).toMatchObject({ state: 'failed', revision: resolved.revision });
  await until(
    async () => (await f.record()).submission?.state === 'failed',
    'procurement records the failed order email',
    30_000,
  );
  const thread = await f.api(`/messaging/threads/${first.threadId}`);
  expect(thread.events).toContainEqual(
    expect.objectContaining({
      type: 'delivery_resolved',
      details: expect.objectContaining({
        outcome: 'not_delivered',
        source: 'person',
      }),
    }),
  );

  // Not delivered lets the buyer send the order again; the supplier answers that one.
  const second = await send();
  await forgedBounce(second.id);
  await f.command('gmail', {
    kind: 'deliver',
    from: { address: f.supplier.email },
    threadOf: `luma.${second.id}@luma-goods.example`,
    text: 'Thanks, we received your order.',
    messageId: `reply-${randomUUID()}@cycle-supplier.example`,
  });
  await until(
    async () => {
      await f.readMail();

      return (await f.record()).submission?.state === 'submitted';
    },
    'the supplier’s authenticated reply settles the order email',
    30_000,
  );
  const settled = (
    await f.api(`/messaging/threads/${second.threadId}`)
  ).outbound.find((item) => item.id === second.id);
  expect(settled).toMatchObject({
    state: 'sent',
    delivery: { resolution: { outcome: 'delivered', source: 'reply' } },
  });
  const sentMessages = (
    await f.f.call('runs/operations/records/gmail?kind=message&limit=100')
  ).items.filter((item) =>
    [first.id, second.id].some(
      (id) => item.data.messageId === `luma.${id}@luma-goods.example`,
    ),
  );
  expect(sentMessages).toHaveLength(2);
}, 120_000);
