import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';
import { expect, vi } from 'vitest';

import { setupSimulator } from './simulator-fixture.mjs';

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
export async function purchasingCycleFixture(
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
