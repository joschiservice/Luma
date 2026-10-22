import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createInventoryLedgerRuntime } from '@luma/application-runtime';
import { createAuditLog } from '@luma/audit/composition';
import { createObservability } from '@luma/platform/composition';
import {
  createProcurement,
  createSupplierCommitmentService,
} from '@luma/procurement/composition';

import { expect, test } from './browser-fixtures.mjs';
import { addMembership } from './helpers.mjs';
import { nativeStockFixture } from './native-stock-fixture.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

const flags = {
  'supplier-purchasing-terms': true,
  'purchasing-workbench': true,
  'purchasing-plans': true,
  'purchasing-receipts': true,
  'purchasing-stock-booking': true,
};

/**
 * Drafts an order through a reviewed plan, records a manual receipt and books it into Shopify
 * stock through the governed correction, then moves the warehouse member to a role that reads
 * procurement but not inventory.
 */
async function bookedOrder(t, origin) {
  const f = await setupSimulator(t, {
    origin,
    historyDays: 14,
    featureFlagOverrides: flags,
    observability: createObservability({
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      featureFlagOverrides: flags,
    }),
  });
  const org = f.manifest.organizationId;
  const login = async (email) => {
    const r = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email, password: f.password },
    });
    assert.equal(r.statusCode, 200, r.body);

    return r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  };
  const buyer = await login('pilot-operator@example.test');
  const owner = await login('pilot-requester@example.test');
  const api = async (
    path,
    body,
    { cookie = buyer, method = body ? 'POST' : 'GET' } = {},
  ) => {
    const r = await f.pilot.app.inject({
      method,
      url: `/v1/organizations/${org}${path}`,
      headers: { origin, cookie, 'x-command-id': randomUUID() },
      ...(body ? { payload: body } : {}),
    });
    assert.ok(r.statusCode < 300, `${method} ${path}: ${r.body}`);

    return r.body ? r.json() : null;
  };
  await f.pilot.observe({ check: false });
  await f.pilot.link();
  for (const group of ['inventory_stock', 'inventory_selling', 'order_lines']) {
    const authority = await api('/source-authority');
    await api('/source-authority', {
      commandId: randomUUID(),
      revision: authority.revision,
      group,
      connectionId: f.manifest.connections.shopify,
    });
  }
  // Only Shopify owns stock reads and writes; the purchasing system is disconnected.
  const connections = await api('/connections');
  const purchasing = (connections.items ?? connections).find(
    (c) => c.id === f.manifest.connections.jtl,
  );
  assert.ok(purchasing);
  await api(`/connections/${purchasing.id}/disconnect`, {
    version: purchasing.version,
  });
  const skuId = (
    await f.db.owner.query(
      `SELECT DISTINCT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='sku' AND external_id=$3`,
      [org, f.manifest.connections.shopify, 'gid://shopify/InventoryItem/1'],
    )
  ).rows[0].canonical_id;
  await f.call('runs/operations/control', {
    action: 'order',
    shop: 'shopify',
    lines: [{ sku: 'LUMA-001', quantity: 14 }],
  });
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'shopify',
    command: { kind: 'available', variant: '1', location: '1', quantity: 0 },
  });
  await f.pilot.observe({ check: false });
  const supplier = await api('/procurement/suppliers', {
    id: randomUUID(),
    name: 'Northstar Supply',
    externalReferences: [],
  });
  await api('/procurement/supplier-terms', {
    id: randomUUID(),
    supplierId: supplier.id,
    skuId,
    expectedRevision: 0,
    reason: 'Reviewed synthetic purchasing terms',
    values: {
      supplierArticleNumber: 'QA-001',
      unitPrice: {
        amount: '3.50',
        currency: 'EUR',
        validFrom: new Date().toISOString().slice(0, 10),
      },
      packSize: 1,
      lineMinimumQuantity: 1,
      leadTimeDays: 7,
      preferred: true,
    },
  });
  const overview = await api('/procurement/purchasing');
  const recommendation = overview.items.find(
    (item) => item.supplierId === supplier.id && item.skuId === skuId,
  );
  assert.ok(recommendation, JSON.stringify(overview));
  const location = recommendation.stocks.find(
    (stock) => stock.authoritative && stock.available !== null,
  );
  assert.ok(location);
  const plan = await api('/procurement/purchasing/plans', {
    id: randomUUID(),
    supplierId: supplier.id,
    reference: 'PO-STOCK-BOOKING',
    lines: [
      {
        skuId,
        locationId: location.locationId,
        quantity: 40,
        termsRevision: recommendation.termsRevision,
      },
    ],
    reason: 'Reviewed quantity for the receipt booking journey',
  });
  const drafted = await api(
    `/procurement/purchasing/plans/${plan.id}/decision`,
    { decisionId: plan.decisionId, outcome: 'approved' },
    { cookie: owner },
  );
  assert.equal(drafted.state, 'verified');
  const orderId = drafted.order.id;
  const { order } = await api(`/procurement/purchase-orders/${orderId}/record`);
  const lineId = order.lines[0].id;
  await api(`/procurement/purchase-orders/${orderId}/transitions`, {
    id: randomUUID(),
    expectedRevision: order.revision,
    status: 'open',
    reason: 'Sent to the supplier by phone',
  });
  await api(`/procurement/purchase-orders/${orderId}/receipts`, {
    id: randomUUID(),
    lineId,
    kind: 'received',
    quantity: 20,
    damagedQuantity: 1,
    expectedCommitmentId: null,
    expectedDamagedCommitmentId: null,
    receivedAt: new Date().toISOString(),
    condition: 'mixed',
    reason: 'One damaged unit in the partial delivery',
    evidence: ['Delivery note: 20 physically received'],
  });
  await f.pilot.observe({ check: false });
  const preview = await api(
    '/apps/shopify/inventory-correction-receipt-preview',
    { requestId: randomUUID(), purchaseOrderId: orderId, lineId },
  );
  await api(
    '/apps/shopify/inventory-correction-approve',
    { id: preview.id, outcome: 'approved' },
    { cookie: owner },
  );
  const booked = await api('/apps/shopify/inventory-correction-execute', {
    id: preview.id,
  });
  assert.equal(booked.state, 'verified');

  // The warehouse member reads purchase orders but not inventory.
  const role = await api(
    '/roles',
    {
      name: 'Procurement readers',
      description: 'Reads purchase orders and suppliers.',
      permissions: ['procurement.read'],
    },
    { cookie: owner },
  );
  const member = (
    await api('/members', undefined, { cookie: owner })
  ).items.find((item) => item.userId === f.manifest.warehouseId);
  assert.ok(member);
  await api(
    `/members/${member.id}`,
    { roleId: role.id },
    { cookie: owner, method: 'PATCH' },
  );
  const reader = await login('pilot-warehouse@example.test');

  return { f, org, api, reader, orderId };
}

test('shows a procurement-only member restricted stock booking rows and their restricted evidence', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const { f, org, api, reader, orderId } = await bookedOrder(t, origin);
  const record = `/procurement/purchase-orders/${orderId}/record`;

  // The API strips the booking's details, not only the page.
  const full = (await api(record)).timeline.entries.filter(
    (entry) => entry.kind === 'stock_booking',
  );
  expect(full.some((entry) => entry.quantity === 19)).toBe(true);
  const restricted = (
    await api(record, undefined, { cookie: reader })
  ).timeline.entries.filter((entry) => entry.kind === 'stock_booking');
  expect(restricted.map((entry) => entry.id).sort()).toEqual(
    full.map((entry) => entry.id).sort(),
  );
  for (const entry of restricted) {
    expect(entry).toMatchObject({
      restricted: { permission: 'inventory.read' },
      actorId: null,
      reason: null,
      quantity: null,
      unit: null,
      detail: null,
    });
    expect(entry.actor).toBeUndefined();
  }

  await web.route(f.apiOrigin);
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies(
    reader.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${org}/procurement/${orderId}`);
  const timeline = page.getByRole('region', { name: 'Purchasing timeline' });
  const notice =
    'Details of this stock booking, such as quantities, locations and who acted, need “View inventory”.';
  await expect(timeline.getByText(notice)).toHaveCount(restricted.length);
  const verified = timeline
    .getByRole('listitem')
    .filter({ hasText: notice })
    .filter({ hasText: 'Independently verified' });
  await expect(verified).toHaveCount(1);
  await expect(verified.getByText(/Recorded by/)).toHaveCount(0);
  await verified.getByText(/^Evidence \(/).click();
  await expect(
    verified.getByText("Evidence you can't open").first(),
  ).toBeVisible();
  await expect(verified.getByText(/No stored evidence found/)).toHaveCount(0);
  await expect(
    verified.getByText(/Someone with “View inventory” can open it/).first(),
  ).toBeVisible();

  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await verified.scrollIntoViewIfNeeded();
    const box = await verified.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await t.attach(`restricted-stock-booking-${colorScheme}-narrow`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  }
  expect(errors).toEqual([]);
});

/**
 * Records a manual receipt for a native-owned location and books it into the native ledger
 * through peer review, then adds a member whose role reads procurement but not inventory.
 */
async function nativeBookedOrder(t, origin) {
  const f = await nativeStockFixture(t, {
    origin,
    observability: createObservability({
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      featureFlagOverrides: flags,
    }),
  });
  const identity = f.f.identity.service;
  const procurement = createProcurement(
    f.db,
    identity.refreshContext,
    createAuditLog,
  );
  const supplier = await procurement.createSupplier(f.owner, {
    id: randomUUID(),
    name: 'Native supplier',
  });
  const lineId = randomUUID();
  const draft = await procurement.createOrder(f.owner, {
    id: randomUUID(),
    supplierId: supplier.id,
    reference: 'PO-NATIVE-BOOKING',
    lines: [
      {
        id: lineId,
        sku: f.base.skuId,
        locationId: f.base.locationId,
        description: 'Receivable item',
        quantity: 100,
        unit: 'each',
      },
    ],
  });
  await procurement.transition(f.owner, draft.id, {
    id: randomUUID(),
    expectedRevision: draft.revision,
    status: 'open',
    reason: 'Order sent and accepted outside the purchasing system',
  });
  const commitments = createSupplierCommitmentService(f.db, createAuditLog, {
    purchasing: null,
    admission: null,
    refreshContext: identity.refreshContext,
    principal: (actorId, tenantId) =>
      identity.resolveWorkflowContext(actorId, tenantId, randomUUID()),
    openOrder: async () => {},
    trace: () => ({
      traceId: randomUUID(),
      spanId: randomUUID(),
      requestId: randomUUID(),
    }),
    model: { gateway: null, available: false, reason: 'Manual evidence' },
    reconciliationAvailable: async () => true,
  });
  await commitments.recordReceipt(f.owner, draft.id, {
    id: randomUUID(),
    lineId,
    kind: 'received',
    quantity: 40,
    damagedQuantity: 2,
    expectedCommitmentId: null,
    expectedDamagedCommitmentId: null,
    receivedAt: new Date().toISOString(),
    condition: 'mixed',
    reason: 'Two damaged units on the signed delivery note',
    evidence: ['delivery-note:40'],
  });
  const ledger = createInventoryLedgerRuntime(f.db, identity, async () => true);
  const review = await ledger.preparePurchaseReceipt(f.owner, {
    id: randomUUID(),
    purchaseOrderId: draft.id,
    lineId,
    reason: 'Book signed receipt; damaged units stay unavailable',
  });
  await ledger.review(f.admin, review.id, true);
  await ledger.postReviewed(f.owner, review.id);

  // The warehouse member reads purchase orders but not inventory.
  const org = f.owner.tenantId;
  const apiOrigin = await f.f.app.listen({ host: '127.0.0.1', port: 0 });
  const api = async (path, body, cookie) => {
    const r = await fetch(`${apiOrigin}/v1/organizations/${org}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        origin,
        cookie,
        'x-command-id': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    assert.ok(r.status < 300, `${path}: ${text}`);

    return text ? JSON.parse(text) : null;
  };
  const role = await api(
    '/roles',
    {
      name: 'Procurement readers',
      description: 'Reads purchase orders and suppliers.',
      permissions: ['procurement.read'],
    },
    f.f.owner.cookie,
  );
  const reader = await f.f.signup('NativeProcurementReader');
  await addMembership(f.f.db.owner, org, reader.id, role.id);

  return {
    org,
    apiOrigin,
    api,
    owner: f.f.owner.cookie,
    reader: reader.cookie,
    orderId: draft.id,
    reviewId: review.id,
  };
}

test('shows a procurement-only member restricted native stock booking rows and their restricted evidence', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const { org, apiOrigin, api, owner, reader, orderId, reviewId } =
    await nativeBookedOrder(t, origin);
  const record = `/procurement/purchase-orders/${orderId}/record`;
  const native = (entries) =>
    entries.filter((entry) => entry.id.startsWith('native-receipt:'));

  // Inventory readers see the booked quantity; the API strips it for the procurement reader.
  const full = native((await api(record, undefined, owner)).timeline.entries);
  expect(full.map((entry) => [entry.id, entry.stage])).toEqual(
    expect.arrayContaining([
      [`native-receipt:${reviewId}:review`, 'approved'],
      [`native-receipt:${reviewId}:proof`, 'verified'],
    ]),
  );
  expect(full.some((entry) => entry.quantity === 38)).toBe(true);
  const restricted = native(
    (await api(record, undefined, reader)).timeline.entries,
  );
  expect(restricted.map((entry) => [entry.id, entry.stage]).sort()).toEqual(
    full.map((entry) => [entry.id, entry.stage]).sort(),
  );
  for (const entry of restricted)
    expect(entry).toMatchObject({
      kind: 'stock_booking',
      source: 'inventory',
      restricted: { permission: 'inventory.read' },
      actorId: null,
      reason: null,
      quantity: null,
      unit: null,
      detail: null,
      evidenceRefs: [reviewId],
    });

  await web.route(apiOrigin);
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies(
    reader.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${org}/procurement/${orderId}`);
  const timeline = page.getByRole('region', { name: 'Purchasing timeline' });
  const notice =
    'Details of this stock booking, such as quantities, locations and who acted, need “View inventory”.';
  await expect(timeline.getByText(notice)).toHaveCount(restricted.length);
  const verified = timeline
    .getByRole('listitem')
    .filter({ hasText: notice })
    .filter({ hasText: 'Independently verified' });
  await expect(verified).toHaveCount(1);
  // The booked quantity stays hidden; a substring match would also find times such as 10:38.
  await expect(verified.getByText(/(?<![\d:.,])38(?![\d:.,])/)).toHaveCount(0);
  await expect(verified.getByText(/Recorded by/)).toHaveCount(0);
  await verified.getByText(/^Evidence \(/).click();
  await expect(
    verified.getByText("Evidence you can't open").first(),
  ).toBeVisible();
  await expect(verified.getByText(/No stored evidence found/)).toHaveCount(0);
  await expect(
    verified.getByText(/Someone with “View inventory” can open it/).first(),
  ).toBeVisible();
  await t.attach('restricted-native-stock-booking', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});
