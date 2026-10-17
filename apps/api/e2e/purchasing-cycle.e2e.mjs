import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';
import { expect, it, vi } from 'vitest';

import { until } from './helpers.mjs';
import { purchasingWorker } from './purchasing-worker-fixture.mjs';
import { setupSimulator } from './simulator-fixture.mjs';
import { expectStoredWriteReceipts } from './write-receipts-fixture.mjs';

const origin = 'http://127.0.0.1:3000';
const flags = {
  'supplier-purchasing-terms': true,
  'purchasing-workbench': true,
  'purchasing-plans': true,
  'purchasing-outcomes': true,
  'purchasing-receipts': true,
  'purchasing-shortfall-decisions': true,
  'purchasing-stock-booking': true,
  'purchasing-incoming': true,
  'procurement-email-submission': true,
  'procurement-supplier-follow-ups': true,
  'adaptive-saved-views': true,
  'adaptive-view-actions': true,
};

/** Runs the real purchasing services against supplier, mail and stock provider observations. */
async function fixture(
  t,
  channel,
  { positiveStock = false, ignoreAlternative = false } = {},
) {
  const f = await setupSimulator(t, {
    historyDays: 14,
    featureFlagOverrides: flags,
    supplierExtraction: { available: true },
    modelGateway: {
      async generate(_trace, request) {
        assert.equal(request.profile, 'supplier-extraction');
        const input = JSON.parse(
          request.messages.find((message) => message.role === 'user').content,
        );
        const match = /We confirm (\d+) units for (\d{4}-\d{2}-\d{2})/.exec(
          input.message.text,
        );

        return {
          output: request.output.parse({
            relatesToOrder: !!match,
            facts: match
              ? [
                  {
                    kind: 'confirmed_quantity',
                    lineId: input.order.lines[0].lineId,
                    quantity: Number(match[1]),
                    date: null,
                    text: null,
                    quote: match[1],
                    confident: true,
                  },
                  {
                    kind: 'promised_date',
                    lineId: input.order.lines[0].lineId,
                    quantity: null,
                    date: match[2],
                    text: null,
                    quote: match[2],
                    confident: true,
                  },
                ]
              : [],
          }),
          toolCalls: [],
          metadata: {
            adapter: 'bedrock',
            model: 'synthetic-purchasing-extraction',
            latencyMs: 1,
            inputTokens: 1,
            outputTokens: 1,
            costUsd: null,
          },
        };
      },
    },
    observability: createObservability({
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      featureFlagOverrides: flags,
    }),
  });
  const org = f.manifest.organizationId;
  const base = `/v1/organizations/${org}`;
  const login = async (email) => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email, password: f.password },
    });
    assert.equal(response.statusCode, 200, response.body);

    return response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  };
  let buyer = await login('pilot-operator@example.test');
  let approver = await login('pilot-requester@example.test');
  const api = async (
    path,
    body,
    { cookie = buyer, method = body ? 'POST' : 'GET', status = 200 } = {},
  ) => {
    const response = await f.pilot.app.inject({
      method,
      url: `${base}${path}`,
      headers: { origin, cookie },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(
      response.statusCode,
      status,
      `${method} ${path}: ${response.body}`,
    );

    return response.body ? response.json() : null;
  };
  const command = (instance, value) =>
    f.call('runs/operations/control', {
      action: 'command',
      instance,
      command: value,
    });
  await f.pilot.observe({ check: false });
  await f.pilot.link();
  const source =
    channel === 'jtl'
      ? f.manifest.connections.jtl
      : f.manifest.connections.shopify;
  for (const group of ['inventory_stock', 'inventory_selling', 'order_lines']) {
    const authority = await api('/source-authority');
    await api('/source-authority', {
      commandId: randomUUID(),
      revision: authority.revision,
      group,
      connectionId:
        group === 'inventory_stock' ? source : f.manifest.connections.shopify,
    });
  }
  const sku = (
    await f.db.owner.query(
      `SELECT DISTINCT m.canonical_id FROM connector_source_mappings m WHERE m.tenant_id=$1 AND m.connection_id=$2 AND m.resource='sku' AND m.external_id=$3`,
      [org, source, channel === 'jtl' ? '1' : 'gid://shopify/InventoryItem/1'],
    )
  ).rows;
  assert.equal(
    sku.length,
    1,
    'The provider has one exact LUMA-001 product identity',
  );
  const skuId = sku[0].canonical_id;
  const supplier = await api('/procurement/suppliers', {
    id: randomUUID(),
    name: 'Cycle Supplier',
    email: 'orders@cycle-supplier.example',
    language: 'en',
    externalReferences: [],
  });
  const alternative = await api('/procurement/suppliers', {
    id: randomUUID(),
    name: 'Alternative Supplier',
    email: 'orders@alternative-supplier.example',
    language: 'en',
    externalReferences: [],
  });
  if (channel === 'jtl') {
    await command('jtl', {
      kind: 'supplier-profile',
      supplierId: '1',
      profile: 'silent',
    });
    const suppliers = await api(
      `/procurement/purchasing-connections/${source}/suppliers`,
    );
    const target = suppliers.items.find((s) => s.externalId === '1');
    assert.ok(target);
    await api(`/procurement/suppliers/${supplier.id}/link`, {
      expectedRevision: 1,
      link: {
        connectionId: source,
        externalId: target.externalId,
        scopeKey: target.scopeKey,
      },
      confirmationHours: 24,
    });
  } else {
    // The merchant's purchasing system is disconnected; only Shopify owns the stock reads/writes.
    const connections = await api('/connections');
    const purchasing =
      connections.items?.find((c) => c.id === f.manifest.connections.jtl) ??
      connections.find?.((c) => c.id === f.manifest.connections.jtl);
    assert.ok(purchasing);
    await api(`/connections/${purchasing.id}/disconnect`, {
      version: purchasing.version,
    });
  }
  for (const vendor of [supplier, alternative]) {
    const existing = await api(
      `/procurement/supplier-terms?supplierId=${vendor.id}&skuId=${skuId}`,
    );
    await api('/procurement/supplier-terms', {
      id: randomUUID(),
      supplierId: vendor.id,
      skuId,
      expectedRevision: existing.items[0]?.revision ?? 0,
      reason: 'Reviewed purchasing cycle terms',
      values: {
        supplierArticleNumber: 'ARTICLE-001',
        unitPrice: {
          amount: '3.50',
          currency: 'EUR',
          validFrom: new Date().toISOString().slice(0, 10),
        },
        packSize: 1,
        lineMinimumQuantity: 1,
        orderMinimumValue: { amount: '100', currency: 'EUR' },
        leadTimeDays: 7,
        preferred: vendor.id === supplier.id,
      },
    });
  }
  await f.call('runs/operations/control', {
    action: 'order',
    shop: 'shopify',
    lines: [{ sku: 'LUMA-001', quantity: 14 }],
  });
  // A real provider count gives the same explicit low-stock starting condition on both paths.
  if (channel === 'jtl')
    await command('jtl', {
      kind: 'stock',
      itemId: '1',
      warehouse: '1',
      quantity: positiveStock ? 25 : 0,
    });
  else
    await command('shopify', {
      kind: 'available',
      variant: '1',
      location: '1',
      quantity: positiveStock ? 7 : 0,
    });
  await f.pilot.observe({ check: false });
  const initial = await api('/procurement/purchasing');
  await api(
    '/procurement/purchasing/settings',
    { ...initial.settings, demandPeriodDays: 7, safetyDays: 7 },
    { method: 'PUT' },
  );
  let overview = await api('/procurement/purchasing');
  const recommendation = overview.items.find(
    (item) => item.supplierId === supplier.id && item.skuId === skuId,
  );
  assert.ok(recommendation, JSON.stringify(overview));
  assert.deepEqual(
    recommendation.missing,
    [],
    JSON.stringify({
      recommendation,
      streams: (
        await f.db.owner.query(
          'SELECT record_type,history_from,backfill_completed_at,recent_history_from,recent_history_completed_at,last_complete_at,blocked,paused FROM commerce_sync_streams WHERE tenant_id=$1 AND connection_id=$2',
          [org, f.manifest.connections.shopify],
        )
      ).rows,
    }),
  );
  const sync = await api('/sync');
  const orderStream = sync.connections
    .find(
      (connection) =>
        connection.connectionId === f.manifest.connections.shopify,
    )
    .recordTypes.find((item) => item.recordType === 'orders').stream;
  assert.ok(orderStream);
  await api(`/sync/${orderStream.id}/commands`, { command: 'pause' });
  expect(
    (await api('/procurement/purchasing')).items.find(
      (item) => item.key === recommendation.key,
    ).missing,
  ).toContain('demand_incomplete');
  await api(`/sync/${orderStream.id}/commands`, { command: 'resume' });
  expect(
    (await api('/procurement/purchasing')).items.find(
      (item) => item.key === recommendation.key,
    ).demand.complete,
  ).toBe(true);
  const location = recommendation.stocks.find(
    (stock) => stock.authoritative && stock.available !== null,
  );
  assert.ok(location);
  await api(
    '/procurement/purchasing/settings',
    { ...overview.settings, locationIds: [location.locationId] },
    { method: 'PUT' },
  );
  overview = await api('/procurement/purchasing');
  expect(overview.items.filter((item) => item.skuId === skuId)).toHaveLength(2);
  const current = overview.items.find(
    (item) => item.supplierId === supplier.id && item.skuId === skuId,
  );
  if (ignoreAlternative)
    await api('/procurement/purchasing/ignored', {
      id: randomUUID(),
      supplierId: alternative.id,
      skuId,
      reason:
        'Reviewed an alternative supplier recommendation; defer buying and measure actual stock outcome',
    });
  const request = {
    id: randomUUID(),
    supplierId: supplier.id,
    reference: `PO-CYCLE-${channel}`,
    lines: [
      {
        skuId,
        locationId: location.locationId,
        quantity: 40,
        termsRevision: current.termsRevision,
      },
    ],
    reason: 'Reviewed quantity adjusted to cover the partial delivery cycle',
  };
  const plan = await api('/procurement/purchasing/plans', request);
  expect(plan.state).toBe('approval_required');
  expect(plan.suggestions[0].chosen).toBe(40);
  expect(plan.suggestions[0].evidenceRefs.length).toBeGreaterThan(0);
  const persistedPlan = (
    await f.db.owner.query(
      'SELECT document FROM procurement_purchasing_plans WHERE tenant_id=$1 AND id=$2',
      [org, plan.id],
    )
  ).rows[0].document;
  const reloadedPlan = (await api('/procurement/purchasing/plans')).items.find(
    (item) => item.id === plan.id,
  );
  for (const key of ['order', 'request', 'suggestions'])
    assert.deepEqual(
      reloadedPlan[key],
      persistedPlan[key],
      `Immutable ${key} survives validation unchanged`,
    );
  await api(
    `/procurement/purchasing/plans/${plan.id}/decision`,
    { decisionId: plan.decisionId, outcome: 'approved' },
    { status: 403 },
  );
  const verified = await api(
    `/procurement/purchasing/plans/${plan.id}/decision`,
    { decisionId: plan.decisionId, outcome: 'approved' },
    { cookie: approver },
  );
  expect(verified.state).toBe('verified');
  expect((await api('/procurement/purchasing/plans', request)).order.id).toBe(
    verified.order.id,
  );
  const restart = async () => {
    f.pilot = await f.restartPilot();
    buyer = await login('pilot-operator@example.test');
    approver = await login('pilot-requester@example.test');
  };
  await restart();
  expect(
    (await api(`/procurement/purchasing/plans/${plan.id}/execute`, {})).state,
  ).toBe('verified');
  const orderId = verified.order.id;
  const lineId = verified.order.lines[0].id;
  const record = () => api(`/procurement/purchase-orders/${orderId}/record`);
  const readMail = async () => {
    await api(`/messaging/mailboxes/${f.manifest.connections.gmail}/sync`, {});
    await f.pilot.messaging.sync({ passes: 5 });
  };
  const advance = async (milliseconds) => {
    const run = await f.call('runs/operations/control', {
      action: 'advance',
      milliseconds,
    });
    const current = run.clock ? run : await f.call('runs/operations');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(current.clock.now);
  };
  t.onTestFinished(() => vi.useRealTimers());

  return {
    f,
    api,
    command,
    org,
    source,
    supplier,
    alternative,
    skuId,
    location,
    plan,
    orderId,
    lineId,
    record,
    readMail,
    restart,
    advance,
    approver: () => approver,
  };
}

for (const channel of ['jtl', 'email'])
  it(`runs a reviewed purchasing cycle with changed commitments and damaged partial receipt through ${channel}`, async (t) => {
    const f = await fixture(t, channel);
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
        (await f.api(`/procurement/submissions/${submission.id}/send`, {}))
          .state,
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
      const afterWorker = await f.api(
        `/messaging/threads/${outbound.threadId}`,
      );
      expect(
        afterWorker.outbound.find((message) => message.id === outbound.id)
          .state,
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
      expect(preview.before.source.available - preview.before.available).toBe(
        19,
      );
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
          entry.source ===
            (channel === 'email' ? 'manual' : 'purchasing_system'),
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
    // Every write receipt the cycle's provider writes cite resolves to one stored receipt.
    const receipts = await expectStoredWriteReceipts(
      f.f.db.owner,
      f.f.manifest.organizationId,
    );
    expect(receipts.length).toBeGreaterThan(0);
  }, 120_000);

for (const channel of ['jtl', 'email'])
  it(`observes availability through receipt and a deferred recommendation stockout through ${channel}`, async (t) => {
    const f = await fixture(t, channel, {
      positiveStock: true,
      ignoreAlternative: true,
    });
    const date = new Date(Date.now() + 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    let externalOrder;
    if (channel === 'jtl') {
      const requested = await f.api(
        `/procurement/purchase-orders/${f.orderId}/submissions`,
        { id: randomUUID(), requestedDeliveryDate: date },
      );
      const submitted = await f.api(
        `/procurement/submissions/${requested.id}/decision`,
        { decisionId: requested.decisionId, outcome: 'approved' },
        { cookie: f.approver() },
      );
      expect(submitted.state).toBe('submitted');
      externalOrder = submitted.externalOrder.externalId;
    } else {
      await f.api('/messaging/mailboxes');
      const draft = await f.api(
        `/procurement/purchase-orders/${f.orderId}/email/submission`,
        {
          id: randomUUID(),
          connectionId: f.f.manifest.connections.gmail,
          requestedDeliveryDate: date,
          company: {
            name: 'Cycle Commerce GmbH',
            address: 'Hauptstraße 1\n10115 Berlin',
            registration: 'Reviewed company identity',
          },
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
    }
    await f.f.pilot.observe({ check: false });
    if (channel === 'jtl') {
      // An actual warehouse adjustment provides a fresh, positive stock observation before receipt.
      await f.command('jtl', {
        kind: 'stock',
        itemId: '1',
        warehouse: '1',
        quantity: 24,
      });
      await f.f.pilot.observe({ check: false });
    }
    const before = await f.api('/procurement/purchasing/outcomes');
    expect(before.items.find((item) => item.orderId === f.orderId).state).toBe(
      'unknown',
    );
    let receipt;
    if (channel === 'jtl') {
      await f.command('jtl', {
        kind: 'purchase-order-receive',
        orderId: externalOrder,
        lines: [
          {
            lineItemId: String(Number(externalOrder) * 1000 + 1),
            quantity: 20,
          },
        ],
      });
      await f.api(`/procurement/purchase-orders/${f.orderId}/refresh`, {});
      receipt = (await f.record()).commitments.find(
        (commitment) => commitment.kind === 'received',
      );
      expect(receipt.source.kind).toBe('purchasing_system');
    } else {
      receipt = await f.api(
        `/procurement/purchase-orders/${f.orderId}/receipts`,
        {
          id: randomUUID(),
          lineId: f.lineId,
          kind: 'received',
          quantity: 20,
          damagedQuantity: 0,
          expectedCommitmentId: null,
          expectedDamagedCommitmentId: null,
          receivedAt: new Date().toISOString(),
          condition: 'good',
          reason: 'Signed receipt for twenty sellable units',
          evidence: ['delivery-note:good-20'],
        },
      );
      const preview = await f.api(
        '/apps/shopify/inventory-correction-receipt-preview',
        {
          requestId: randomUUID(),
          purchaseOrderId: f.orderId,
          lineId: f.lineId,
        },
      );
      expect(preview.before.source.available - preview.before.available).toBe(
        20,
      );
      await f.api(
        '/apps/shopify/inventory-correction-approve',
        { id: preview.id, outcome: 'approved' },
        { cookie: f.approver() },
      );
      expect(
        (
          await f.api('/apps/shopify/inventory-correction-execute', {
            id: preview.id,
          })
        ).state,
      ).toBe('verified');
    }
    await f.f.pilot.observe({ check: false });
    const throughReceipt = await f.api('/procurement/purchasing/outcomes');
    const outcome = throughReceipt.items.find(
      (item) => item.orderId === f.orderId,
    );
    expect(
      outcome,
      JSON.stringify({
        outcome,
        receipt,
        stocks: (
          await f.f.db.owner.query(
            "SELECT connection_id,observed_at,document->'data'->>'available' AS available FROM inventory_snapshots WHERE tenant_id=$1 AND sku_id=$2 AND kind='position' AND observed_at >= $3::timestamptz ORDER BY observed_at",
            [f.org, f.skuId, outcome.decidedAt],
          )
        ).rows,
      }),
    ).toMatchObject({
      state: 'available_through_receipt',
      complete: true,
    });
    if (channel === 'jtl') expect(outcome.evidenceRefs).toContain(receipt.id);
    else expect(outcome.evidenceRefs.length).toBeGreaterThanOrEqual(2);
    expect(throughReceipt.summary.verifiedAvailable).toBe(1);
    // The declined alternative remains a separate human decision; zero stock is provider evidence.
    await f.command(
      channel === 'jtl' ? 'jtl' : 'shopify',
      channel === 'jtl'
        ? { kind: 'stock', itemId: '1', warehouse: '1', quantity: 0 }
        : { kind: 'available', variant: '1', location: '1', quantity: 0 },
    );
    await f.f.pilot.observe({ check: false });
    const after = await f.api('/procurement/purchasing/outcomes');
    const ignored = after.items.find(
      (item) =>
        item.decision === 'ignored' && item.supplierId === f.alternative.id,
    );
    expect(ignored).toMatchObject({
      state: 'stockout_observed',
      complete: true,
    });
    expect(ignored.evidenceRefs.length).toBeGreaterThan(0);
    expect(ignored.stockoutAt).toBeTruthy();
  }, 120_000);

it('settles an order email made uncertain by a forged bounce through a person’s decision or the supplier’s authenticated reply', async (t) => {
  const f = await fixture(t, 'email', { ignoreAlternative: true });
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
