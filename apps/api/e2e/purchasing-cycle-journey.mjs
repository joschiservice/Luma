import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import { until } from './helpers.mjs';
import { purchasingCycleFixture } from './purchasing-cycle-fixture.mjs';
import { purchasingWorker } from './purchasing-worker-fixture.mjs';
import { expectStoredWriteReceipts } from './write-receipts-fixture.mjs';

/**
 * Runs a reviewed purchasing cycle through one submission channel, `jtl` or `email`: the
 * supplier changes its commitment and a damaged partial receipt follows, while a separate
 * purchasing worker process sends, restarts and verifies by fresh reads. Each channel runs in
 * its own journey file so the two long cycles do not run in sequence. `options` go to
 * `purchasingCycleFixture`.
 */
export async function reviewedPurchasingCycle(t, channel, options) {
  const f = await purchasingCycleFixture(t, channel, options);
  let worker = await purchasingWorker(t, f.f.purchasingWorkerConfiguration());
  const restartWorker = async () => {
    const pid = worker.pid;
    await worker.stop();
    worker = await purchasingWorker(t, f.f.purchasingWorkerConfiguration());
    expect(worker.pid).not.toBe(pid);
    await worker.pass();
  };
  const requestedDate = new Date(Date.now() + 2 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  let outbound;
  let submission;
  if (channel === 'jtl') {
    submission = await f.api(
      `/procurement/purchase-orders/${f.orderId}/submissions`,
      { id: randomUUID(), requestedDeliveryDate: requestedDate },
    );
    submission = await f.api(
      `/procurement/submissions/${submission.id}/decision`,
      { decisionId: submission.decisionId, outcome: 'approved' },
      { cookie: f.approver() },
    );
    expect(submission.state).toBe('submitted');
    await restartWorker();
    await f.restart();
    expect(
      (await f.api(`/procurement/submissions/${submission.id}/send`, {})).state,
    ).toBe('submitted');
  } else {
    await f.api('/messaging/mailboxes');
    const draftRequest = {
      id: randomUUID(),
      connectionId: f.f.manifest.connections.gmail,
      requestedDeliveryDate: requestedDate,
      company: {
        name: 'Cycle Commerce GmbH',
        address: 'Hauptstraße 1\n10115 Berlin',
        registration: 'Cycle reviewed company identity',
      },
    };
    outbound = await f.api(
      `/procurement/purchase-orders/${f.orderId}/email/submission`,
      draftRequest,
    );
    expect(
      (
        await f.api(
          `/procurement/purchase-orders/${f.orderId}/email/submission`,
          draftRequest,
        )
      ).id,
    ).toBe(outbound.id);
    const pdf = await f.api(
      `/procurement/purchase-orders/${f.orderId}/email/outgoing/${outbound.id}/document`,
    );
    expect(Buffer.from(pdf.base64, 'base64').subarray(0, 4).toString()).toBe(
      '%PDF',
    );
    const requested = await f.api(
      `/messaging/outbound/${outbound.id}/request`,
      { id: randomUUID() },
    );
    await f.api(
      `/messaging/outbound/${outbound.id}/decision`,
      { decisionId: requested.decisionId, outcome: 'approved' },
      { status: 409 },
    );
    await f.f.call('runs/operations/control', {
      action: 'fault',
      rule: {
        id: randomUUID(),
        instance: 'gmail',
        operation: 'messages.send',
        kind: 'response-loss',
        occurrence: 1,
        remaining: 1,
      },
    });
    let sent = await f.api(
      `/messaging/outbound/${outbound.id}/decision`,
      { decisionId: requested.decisionId, outcome: 'approved' },
      { cookie: f.approver() },
    );
    expect(['uncertain', 'sent']).toContain(sent.state);
    await restartWorker();
    const afterWorker = await f.api(`/messaging/threads/${outbound.threadId}`);
    expect(
      afterWorker.outbound.find((message) => message.id === outbound.id).state,
    ).toBe('sent');
    await f.restart();
    await until(
      async () => {
        sent = await f.api(`/messaging/outbound/${outbound.id}/check`, {
          id: randomUUID(),
        });

        return sent.state === 'sent';
      },
      'supplier email verified after restart',
      30_000,
    );
    await f.api(`/messaging/outbound/${outbound.id}/send`, {
      id: randomUUID(),
    });
    const sentMessages = (
      await f.f.call('runs/operations/records/gmail?kind=message&limit=100')
    ).items.filter(
      (item) =>
        item.data.messageId === `luma.${outbound.id}@luma-goods.example`,
    );
    expect(sentMessages).toHaveLength(1);
    const actual = await f.record();
    expect(actual.submission).toMatchObject({
      channel: 'email',
      state: 'submitted',
    });
    expect(actual.stage).toBe('awaiting_confirmation');
    expect(
      actual.commitments.filter((c) => c.kind === 'confirmed_quantity'),
    ).toHaveLength(0);
  }
  await worker.stop();
  await f.advance(86_400_000);
  await f.advance(86_400_000);
  await f.advance(60_000);
  let actual = await f.record();
  const overdue = actual.progress.attention.find(
    (item) => item.kind === 'confirmation_overdue',
  );
  assert.ok(overdue, JSON.stringify(actual.progress));
  await f.api('/messaging/mailboxes');
  const followRequest = {
    id: randomUUID(),
    connectionId: f.f.manifest.connections.gmail,
    attentionKey: overdue.key,
    nextCheckAt: new Date(Date.now() + 86_400_000).toISOString(),
    reason: 'Supplier confirmation deadline passed',
  };
  let follow;
  if (channel === 'email') {
    const actionId = randomUUID();
    const view = await f.api('/adaptive/views', {
      commandId: randomUUID(),
      name: 'Purchasing follow-ups',
      description: 'Review overdue supplier confirmations.',
      sharing: { scope: 'private', roleIds: [] },
      reviewed: true,
      query: {
        version: 1,
        domain: 'procurement',
        filters: { attention: 'confirmation_overdue' },
        customFilters: [],
        columns: ['reference', 'supplierName', 'attentionKey'],
        sort: null,
        groupBy: null,
        layout: 'table',
        metrics: [],
        charts: [],
        actions: [
          {
            id: actionId,
            label: { en: 'Prepare follow-up', de: 'Nachfrage vorbereiten' },
            target: { kind: 'capability', id: 'supplier.follow-up' },
            inputs: {
              connectionId: {
                source: 'literal',
                value: followRequest.connectionId,
              },
              attentionKey: { source: 'row', field: 'attentionKey' },
              nextCheckHours: { source: 'literal', value: 24 },
              reason: { source: 'literal', value: followRequest.reason },
            },
          },
        ],
      },
    });
    const actionPath = `/adaptive/views/${view.id}/actions/${actionId}`;
    const selection = { commandId: randomUUID(), recordIds: [f.orderId] };
    const preview = await f.api(`${actionPath}/preview`, selection);
    expect(preview.items[0]).toMatchObject({
      recordId: f.orderId,
      available: true,
    });
    expect(preview.items[0].approval).toContain('approval');
    const runRequest = { ...selection, reviewDigest: preview.reviewDigest };
    const proposed = await f.api(`${actionPath}/run`, runRequest);
    expect(proposed.items[0]).toMatchObject({
      recordId: f.orderId,
      state: 'proposed',
    });
    expect(await f.api(`${actionPath}/run`, runRequest)).toEqual(proposed);
    const thread = await f.api(
      `/messaging/threads/${proposed.items[0].destination.split('/')[1]}`,
    );
    follow = thread.outbound.find(
      (item) => item.id === proposed.items[0].proposalId,
    );
    expect(follow.state).toBe('draft');
    expect((await f.record()).followUps).toHaveLength(0);
  } else {
    follow = await f.api(
      `/procurement/purchase-orders/${f.orderId}/email/follow-up`,
      followRequest,
    );
  }
  const followRequested = await f.api(
    `/messaging/outbound/${follow.id}/request`,
    { id: randomUUID() },
  );
  await f.api(
    `/messaging/outbound/${follow.id}/decision`,
    { decisionId: followRequested.decisionId, outcome: 'approved' },
    { cookie: f.approver() },
  );
  await until(
    async () => {
      const current = await f.api(`/messaging/outbound/${follow.id}/check`, {
        id: randomUUID(),
      });

      return current.state === 'sent';
    },
    'supplier follow-up independently verified',
    30_000,
  );
  actual = await f.record();
  expect(
    actual.followUps.find((item) => item.id === follow.id)?.nextCheckAt,
  ).toBe(followRequest.nextCheckAt);
  const changedDate = new Date(Date.now() + 3 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (channel === 'jtl') {
    await f.command('jtl', {
      kind: 'purchase-order-confirm',
      orderId: submission.externalOrder.externalId,
      lines: [
        {
          lineItemId: String(
            Number(submission.externalOrder.externalId) * 1000 + 1,
          ),
          quantity: 35,
          deliveryDate: changedDate,
        },
      ],
    });
    actual = await f.api(
      `/procurement/purchase-orders/${f.orderId}/refresh`,
      {},
    );
  } else {
    const reply = await f.command('gmail', {
      kind: 'deliver',
      from: { address: f.supplier.email },
      threadOf: `luma.${follow.id}@luma-goods.example`,
      text: `We confirm 35 units for ${changedDate}.`,
      messageId: `confirm-${randomUUID()}@cycle-supplier.example`,
    });
    expect(reply).toBeTruthy();
    await f.readMail();
    actual = await f.record();
    expect(actual.communications).toHaveLength(1);
    // Provider message evidence is real; only the model's proposed structured output is a fixture.
    const proposed = actual.commitments.filter(
      (commitment) => commitment.status === 'needs_review',
    );
    expect(proposed).toHaveLength(2);
    expect(actual.progress.lines[0].confirmed).toBe(null);
    for (const commitment of proposed) {
      expect(commitment.source.kind).toBe('communication');
      expect(commitment.source.communicationId).toBe(
        actual.communications[0].id,
      );
      await f.api(`/procurement/commitments/${commitment.id}/review`, {
        outcome: 'confirmed',
        acceptChange: false,
      });
    }
    actual = await f.record();
  }
  const changes = actual.progress.attention.filter(
    (item) => item.kind === 'commitment_changed',
  );
  expect(changes.length).toBeGreaterThan(0);
  for (const item of changes)
    await f.api(`/procurement/purchase-orders/${f.orderId}/follow-ups`, {
      id: randomUUID(),
      key: item.key,
      response: 'accepted',
      note: 'Accept 35 units and the revised arrival date; keep the remainder visible in the purchasing decision history',
      nextCheckAt: null,
    });
  for (let day = 0; day < 4; day++) await f.advance(86_400_000);
  const delivery = (await f.record()).progress.attention.find(
    (item) => item.kind === 'delivery_overdue',
  );
  assert.ok(
    delivery,
    'The new supplier promise becomes overdue on the simulator clock',
  );
  const deliveryRequest = {
    id: randomUUID(),
    connectionId: f.f.manifest.connections.gmail,
    threadId: follow.threadId,
    attentionKey: delivery.key,
    nextCheckAt: new Date(Date.now() + 86_400_000).toISOString(),
    reason: 'The supplier missed the revised promised delivery date',
  };
  const deliveryDraft = await f.api(
    `/procurement/purchase-orders/${f.orderId}/email/follow-up`,
    deliveryRequest,
  );
  expect(deliveryDraft.threadId).toBe(follow.threadId);
  expect(deliveryDraft.text).toContain(changedDate);
  expect(deliveryDraft.text).toContain('35');
  const deliveryApproval = await f.api(
    `/messaging/outbound/${deliveryDraft.id}/request`,
    { id: randomUUID() },
  );
  const deliverySent = await f.api(
    `/messaging/outbound/${deliveryDraft.id}/decision`,
    { decisionId: deliveryApproval.decisionId, outcome: 'approved' },
    { cookie: f.approver() },
  );
  expect(deliverySent.state).toBe('sent');
  const afterDelivery = await f.record();
  expect(
    afterDelivery.followUps.find((item) => item.id === deliveryDraft.id)
      ?.nextCheckAt,
  ).toBe(deliveryRequest.nextCheckAt);
  expect(
    afterDelivery.progress.attention.some(
      (item) => item.kind === 'delivery_overdue',
    ),
  ).toBe(false);
  if (channel === 'jtl') {
    await f.f.pilot.observe({ check: false });
    const beforeInventory = await f.api(
      `/inventory?skuId=${f.skuId}&connectionId=${f.source}`,
    );
    const stockBefore = beforeInventory.items
      .find((p) => p.locationId === f.location.locationId)
      ?.sources.find((s) => s.connectionId === f.source);
    assert.ok(stockBefore?.available !== null && stockBefore);
    await f.command('jtl', {
      kind: 'purchase-order-receive',
      orderId: submission.externalOrder.externalId,
      lines: [
        {
          lineItemId: String(
            Number(submission.externalOrder.externalId) * 1000 + 1,
          ),
          quantity: 20,
          damagedQuantity: 1,
        },
      ],
    });
    await f.api(`/procurement/purchase-orders/${f.orderId}/refresh`, {});
    await f.api(`/procurement/purchase-orders/${f.orderId}/receipts`, {
      id: randomUUID(),
      lineId: f.lineId,
      kind: 'damaged',
      quantity: 1,
      expectedCommitmentId: null,
      receivedAt: new Date().toISOString(),
      condition: 'damaged',
      reason: 'Provider receiving operator quarantined one damaged unit',
      evidence: ['Receiving note: 20 received, 19 sellable, one quarantined'],
    });
    await f.f.pilot.observe({ check: false });
    const afterInventory = await f.api(
      `/inventory?skuId=${f.skuId}&connectionId=${f.source}`,
    );
    const stockAfter = afterInventory.items
      .find((p) => p.locationId === f.location.locationId)
      ?.sources.find((s) => s.connectionId === f.source);
    assert.ok(stockAfter);
    expect(Number(stockAfter.available) - Number(stockBefore.available)).toBe(
      19,
    );
    expect(Number(stockAfter.onHand) - Number(stockBefore.onHand)).toBe(20);
  } else {
    await f.api(`/procurement/purchase-orders/${f.orderId}/receipts`, {
      id: randomUUID(),
      lineId: f.lineId,
      kind: 'received',
      quantity: 20,
      damagedQuantity: 1,
      expectedCommitmentId: null,
      expectedDamagedCommitmentId: null,
      receivedAt: new Date().toISOString(),
      condition: 'mixed',
      reason: 'One damaged unit in the partial delivery',
      evidence: [
        'Delivery note: 20 physically received',
        'Photo of one damaged unit',
      ],
    });
    await f.f.pilot.observe({ check: false });
    const bookingRequestId = randomUUID();
    const preview = await f.api(
      '/apps/shopify/inventory-correction-receipt-preview',
      {
        requestId: bookingRequestId,
        purchaseOrderId: f.orderId,
        lineId: f.lineId,
      },
    );
    expect(preview.before.source.available - preview.before.available).toBe(19);
    await f.api(
      '/apps/shopify/inventory-correction-approve',
      { id: preview.id, outcome: 'approved' },
      { cookie: f.approver() },
    );
    const booked = await f.api('/apps/shopify/inventory-correction-execute', {
      id: preview.id,
    });
    expect(booked.state).toBe('verified');
    await f.restart();
    expect(
      (
        await f.api('/apps/shopify/inventory-correction-check', {
          id: preview.id,
        })
      ).state,
    ).toBe('verified');
    const second = await f.api(
      '/apps/shopify/inventory-correction-receipt-preview',
      {
        requestId: bookingRequestId,
        purchaseOrderId: f.orderId,
        lineId: f.lineId,
      },
    );
    expect(second.id).toBe(preview.id);
    await f.api(
      '/apps/shopify/inventory-correction-receipt-preview',
      {
        requestId: randomUUID(),
        purchaseOrderId: f.orderId,
        lineId: f.lineId,
      },
      { status: 409 },
    );
  }
  actual = await f.record();
  expect(actual.stage).toBe('partially_received');
  expect(actual.progress.lines[0]).toMatchObject({
    ordered: 40,
    confirmed: 35,
    received: 20,
    damaged: 1,
    goodReceived: 19,
    outstanding: 15,
  });
  expect(
    actual.progress.attention.some(
      (item) => item.kind === 'receipt_difference',
    ),
  ).toBe(true);
  const incoming = await f.api('/procurement/incoming-stock', {
    skuIds: [f.skuId],
  });
  expect(JSON.stringify(incoming)).toContain(f.orderId);
  const queue = await f.api('/decisions?view=all&limit=100');
  expect(
    queue.items.some((item) => item.owner?.purchaseOrderId === f.orderId),
  ).toBe(true);
  const outcomes = await f.api('/procurement/purchasing/outcomes');
  const outcome = outcomes.items.find((item) => item.orderId === f.orderId);
  assert.ok(outcome);
  expect(outcome.complete).toBe(false);
  expect(outcomes.summary.verifiedAvailable).toBe(0);
  expect(actual.timeline.complete).toBe(true);
  const timeline = actual.timeline.entries;
  expect(
    timeline.some(
      (entry) =>
        entry.kind === 'draft' &&
        entry.stage === 'verified' &&
        entry.evidenceRefs.length > 0,
    ),
  ).toBe(true);
  expect(
    timeline.some(
      (entry) =>
        entry.kind === 'submission' &&
        entry.stage === (channel === 'email' ? 'sent' : 'verified') &&
        entry.evidenceRefs.length > 0,
    ),
  ).toBe(true);
  expect(
    timeline.some(
      (entry) =>
        entry.kind === 'follow_up' && entry.evidenceRefs.includes(follow.id),
    ),
  ).toBe(true);
  expect(
    timeline.some(
      (entry) =>
        entry.kind === 'commitment' &&
        entry.detail === 'received' &&
        entry.quantity === 20 &&
        entry.source === (channel === 'email' ? 'manual' : 'purchasing_system'),
    ),
  ).toBe(true);
  expect(
    timeline.some(
      (entry) =>
        entry.kind === 'commitment' &&
        entry.detail === 'damaged' &&
        entry.quantity === 1 &&
        entry.source === 'manual' &&
        entry.evidenceRefs.length > 0,
    ),
  ).toBe(true);
  if (channel === 'email') {
    expect(
      timeline.some(
        (entry) =>
          entry.kind === 'supplier_message' && entry.source === 'email',
      ),
    ).toBe(true);
    expect(
      timeline.some(
        (entry) =>
          entry.kind === 'commitment' &&
          entry.stage === 'approved' &&
          entry.detail === 'confirmed_quantity',
      ),
    ).toBe(true);
    expect(
      timeline.some(
        (entry) =>
          entry.kind === 'stock_booking' &&
          entry.stage === 'verified' &&
          entry.evidenceRefs.length > 0,
      ),
    ).toBe(true);
  }
  // Every reference the timeline cites resolves through its owner: plan stock and demand reads,
  // lifecycle events, receipts, messages and records, never "unresolved".
  const cited = [...new Set(timeline.flatMap((entry) => entry.evidenceRefs))];
  expect(cited.length).toBeGreaterThan(0);
  const resolved = [];
  for (let index = 0; index < cited.length; index += 100) {
    const page = await f.api('/evidence/resolve', {
      subject: { kind: 'purchase_order', id: f.orderId },
      refs: cited.slice(index, index + 100),
    });
    resolved.push(...page.items);
  }
  expect(
    resolved
      .filter((item) => item.resolution.kind === 'unresolved')
      .map((item) => item.ref),
  ).toEqual([]);
  const kinds = new Set(
    resolved.map((item) =>
      item.resolution.kind === 'luma_record'
        ? item.resolution.record
        : item.resolution.kind,
    ),
  );
  expect(kinds).toContain('procurement_event');
  // The plan that drafted the order cites the stock reads it relied on.
  expect(kinds).toContain('read');
  if (channel === 'email') expect(kinds).toContain('message');
  // Every write receipt the cycle's provider writes cite resolves to one stored receipt.
  const receipts = await expectStoredWriteReceipts(
    f.f.db.owner,
    f.f.manifest.organizationId,
  );
  expect(receipts.length).toBeGreaterThan(0);
}
