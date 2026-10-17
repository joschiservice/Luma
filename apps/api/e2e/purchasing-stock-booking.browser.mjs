import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
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
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
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

  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: f.apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
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
