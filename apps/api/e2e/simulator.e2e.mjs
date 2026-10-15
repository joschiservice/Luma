import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { until } from './helpers.mjs';
import { metricStream } from './metric-stream-fixture.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

/** Signs in as the pilot operator on the in-process pilot API. */
async function operatorCookie(f) {
  const response = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { email: 'pilot-operator@example.test', password: f.password },
  });
  expect(response.statusCode).toBe(200);

  return response.cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
}

test('pilot imports simulated history through commerce sync, serves live metrics and releases its listener on shutdown', async (t) => {
  const f = await setupSimulator(t);
  const base = `/v1/organizations/${f.manifest.organizationId}`;
  const cookie = await operatorCookie(f);
  const streams = await Promise.all(
    Array.from({ length: 2 }, () =>
      metricStream(t, f.apiOrigin, {
        base,
        org: { id: f.manifest.organizationId },
        owner: { cookie },
      }),
    ),
  );
  await until(
    () => streams.every((stream) => stream.events.at(-1)?.connected),
    'pilot metric listener connected',
  );
  const before = streams.map((stream) => stream.events.length);
  await f.pilot.observe();
  const sync = await f.pilot.app.inject({
    method: 'GET',
    url: `${base}/sync`,
    headers: { cookie },
  });
  expect(sync.statusCode).toBe(200);
  expect(sync.json().connections).toHaveLength(3);
  const metrics = async () => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: `${base}/metrics/query`,
      headers: { cookie, origin: 'http://127.0.0.1:3000' },
      payload: {},
    });
    expect(response.statusCode).toBe(200);

    return response.json();
  };
  const initial = await metrics();
  expect(initial.observedAt).not.toBeNull();
  const canonicalOrders = async () =>
    (
      await f.db.owner.query(
        "SELECT p.entity_id,count(DISTINCT p.connection_id)::int AS sources FROM orders_projections p JOIN orders_snapshots s ON s.id=p.snapshot_id WHERE s.kind='order' GROUP BY p.entity_id",
      )
    ).rows;
  // Exact references link the shop, ERP and shipping views without manual steps.
  expect(await canonicalOrders()).toHaveLength(2);
  expect((await canonicalOrders()).every((row) => row.sources === 3)).toBe(
    true,
  );
  await f.call('runs/operations/control', {
    action: 'order',
    lines: [{ sku: 'LUMA-001', quantity: 5 }],
  });
  await f.call('runs/operations/control', {
    action: 'advance',
    milliseconds: 60_000,
  });
  await f.pilot.observe();
  expect(await canonicalOrders()).toHaveLength(3);
  await until(
    () =>
      streams.every((stream, index) =>
        stream.events.slice(before[index]).some((event) => event.refetch),
      ),
    'provider imports invalidate both Insights subscriptions',
  );
  const listeners = async () =>
    (
      await f.db.owner.query(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='luma-metric-listener'",
      )
    ).rows.length;
  expect(await listeners()).toBe(1);
  await f.pilot.close();
  await until(() => streams.every((stream) => stream.ended), 'streams closed');
  await expect.poll(listeners).toBe(0);
});

test('imports JTL customers with their orders and flags a customer deleted in JTL', async (t) => {
  const f = await setupSimulator(t);
  const base = `/v1/organizations/${f.manifest.organizationId}`;
  const cookie = await operatorCookie(f);
  const jtl = f.manifest.connections.jtl;
  const api = async (url, options = {}) => {
    const response = await f.pilot.app.inject({
      url: `${base}${url}`,
      headers: { cookie, origin: 'http://127.0.0.1:3000' },
      ...options,
    });
    expect(response.statusCode).toBe(200);

    return response.json();
  };
  const customers = async () =>
    (await api(`/customers?connectionId=${jtl}`)).items;
  await f.pilot.observe();
  // The order integration carries each fixture order's shop customer into JTL.
  const [buyer] = await customers();
  expect(buyer).toMatchObject({ missingSince: null });
  expect(buyer.email).toMatch(/@/);
  const history = await api(`/orders?customerId=${buyer.id}`);
  expect(history.items.length).toBeGreaterThan(0);
  expect(
    history.items.every((order) =>
      order.sources.some((source) => source.connectionId === jtl),
    ),
  ).toBe(true);

  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'jtl',
    command: { kind: 'delete-customer', id: buyer.externalId },
  });
  const stream = (await api('/sync')).connections
    .find((item) => item.connectionId === jtl)
    .recordTypes.find((item) => item.recordType === 'customers').stream;
  await api(`/sync/${stream.id}/commands`, {
    method: 'POST',
    payload: { command: 'reconcile' },
  });
  await f.pilot.observe({ refresh: false });
  // One full read without the customer flags them; the profile and its history stay.
  const flagged = (await customers()).find((item) => item.id === buyer.id);
  expect(flagged.missingSince).not.toBeNull();
  expect((await api(`/orders?customerId=${buyer.id}`)).items).toHaveLength(
    history.items.length,
  );
});

test('signed Shopify webhooks reach the real change route and schedule early reads', async (t) => {
  const f = await setupSimulator(t);
  await f.pilot.observe();
  const hints = async () =>
    (
      await f.db.owner.query(
        'SELECT capabilities FROM connector_refresh_hints WHERE connection_id=$1 ORDER BY received_at',
        [f.manifest.connections.shopify],
      )
    ).rows;
  const already = (await hints()).length;
  await f.call('runs/operations/control', {
    action: 'order',
    lines: [{ sku: 'LUMA-001', quantity: 1 }],
  });
  // The order and its stock change arrive as separate webhooks, in either order.
  await until(
    async () =>
      (await hints())
        .slice(already)
        .some((row) => row.capabilities.includes('orders.read')),
    'order webhook stored a refresh hint',
    20_000,
  );
});

test('projects orders and fulfillments beyond the first provider page', async (t) => {
  const f = await setupSimulator(t);
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'jtl',
    command: { kind: 'stock', itemId: '1', warehouse: '1', quantity: 500 },
  });
  for (let index = 0; index < 101; index++)
    await f.call('runs/operations/control', {
      action: 'order',
      lines: [{ sku: 'LUMA-001', quantity: 1 }],
    });
  await f.call('runs/operations/control', {
    action: 'advance',
    milliseconds: 60_000,
  });
  const open = [];
  let after;
  do {
    const page = await f.call(
      `runs/operations/records/jtl?kind=sales-order&limit=100${after ? `&after=${after}` : ''}`,
    );
    open.push(...page.items.filter((item) => !['1', '10'].includes(item.id)));
    after = page.next;
  } while (after);
  expect(open).toHaveLength(101);
  for (const order of open)
    await f.call('runs/operations/control', {
      action: 'command',
      instance: 'jtl',
      command: { kind: 'ship', id: order.id, warehouse: '1' },
    });
  await f.pilot.observe();
  const projected = await f.db.owner.query(
    'SELECT s.kind,count(*)::int AS count FROM orders_projections p JOIN orders_snapshots s ON s.id=p.snapshot_id WHERE p.connection_id=$1 GROUP BY s.kind ORDER BY s.kind',
    [f.manifest.connections.jtl],
  );
  expect(projected.rows).toEqual([
    { kind: 'fulfillment', count: 101 },
    { kind: 'order', count: 103 },
  ]);
}, 120_000);

test('inventory drift is detected, verified, scored and recurs through the same HTTP APIs as the panel', async (t) => {
  const f = await setupSimulator(t);
  const check = () => f.call('runs/operations/operations/check', {});
  const status = () => f.call('runs/operations/operations');
  const inject = (id) =>
    f.call('runs/operations/incidents', {
      id,
      kind: 'inventory-drift',
      target: 'LUMA-SCENARIO-001',
    });
  const recover = (id) => f.call(`runs/operations/incidents/${id}/recover`, {});
  expect(await check()).toMatchObject({
    connected: true,
    incident: null,
    lastCheck: { outcome: 'clear' },
  });
  const id = randomUUID();
  const injected = await inject(id);
  expect(injected).toMatchObject({ id, status: 'active', origin: 'injected' });
  expect((await inject(id)).id).toBe(id);
  const detected = await check();
  expect(detected.lastCheck, JSON.stringify(detected)).toMatchObject({
    outcome: 'detect',
  });
  expect(detected.incident).toMatchObject({
    occurrenceCount: 1,
    previousExceptionId: null,
  });
  const firstId = detected.incident.id;
  const actor = await f.pilot.operator();
  const sources = await f.pilot.detection.exceptions.evidence(actor, firstId);
  expect(sources).toHaveLength(3);
  expect((await check()).incident).toMatchObject({
    id: firstId,
    occurrenceCount: 2,
  });
  const scored = await f.call('runs/operations/scorecard');
  expect(scored.luma).toEqual({ connected: true, error: null });
  expect(
    scored.byKind.find((row) => row.kind === 'inventory-drift'),
  ).toMatchObject({
    total: 1,
    detected: 1,
  });
  const view = (await f.call('runs/operations/incidents')).find(
    (incident) => incident.id === id,
  );
  expect(view.detection).toMatchObject({ state: 'detected', caseId: firstId });
  await recover(id);
  expect((await status()).incident.state).not.toBe('resolved');
  await f.call('runs/operations/control', {
    action: 'service-health',
    instance: 'shopify',
    status: 'unavailable',
  });
  expect((await check()).lastCheck.outcome).toBe('unavailable');
  expect((await status()).incident.state).not.toBe('resolved');
  await f.call('runs/operations/control', {
    action: 'service-health',
    instance: 'shopify',
    status: 'healthy',
  });
  const recovered = await check();
  expect(recovered.lastCheck, JSON.stringify(recovered)).toMatchObject({
    outcome: 'clear',
  });
  expect(recovered.incident).toMatchObject({ id: firstId, state: 'resolved' });
  const resolved = await f.pilot.detection.exceptions.get(actor, firstId);
  expect(resolved.resolution).toMatchObject({
    kind: 'verification',
    outcome: 'passed',
    authoritative: true,
    complete: true,
  });
  expect(
    resolved.resolution.evidence.every(
      (item) => !sources.some((source) => source.key === item.key),
    ),
  ).toBe(true);
  const next = randomUUID();
  await inject(next);
  const recurrence = await check();
  expect(recurrence.incident).toMatchObject({
    previousExceptionId: firstId,
    occurrenceCount: 1,
  });
  // An old recovery request leaves the new occurrence intact.
  await recover(id);
  expect((await check()).lastCheck.outcome).toBe('detect');
  await recover(next);
  expect((await check()).incident).toMatchObject({
    id: recurrence.incident.id,
    state: 'resolved',
  });
  await f.call('runs/operations/control', { action: 'reset' });
  await f.ready();
  expect((await check()).lastCheck.outcome).toBe('clear');
  const unauthenticated = await fetch(
    `${f.apiOrigin}/v1/organizations/${f.manifest.organizationId}/simulator/inventory`,
  );
  expect(unauthenticated.status).toBe(401);
});

test('scheduled detection compares linked stock and closes the case only after fresh verification', async (t) => {
  const f = await setupSimulator(t);
  const actor = await f.pilot.operator();
  const stockCases = async () =>
    (await f.pilot.detection.exceptions.list(actor)).filter(
      (incident) =>
        incident.exceptionClass === 'inventory_mismatch' &&
        incident.subject.scope.includes(f.manifest.connections.shopify) &&
        !f.pilot.inventoryScenario?.matches(incident),
    );
  await f.pilot.observe({ check: false });
  expect(await f.pilot.link()).toEqual({ linked: 1, remaining: 0 });
  await f.pilot.detect();
  expect(await stockCases()).toEqual([]);

  const id = randomUUID();
  await f.call('runs/operations/incidents', {
    id,
    kind: 'inventory-drift',
    target: 'LUMA-001',
  });
  await f.pilot.observe({ check: false });
  // A small gap waits for provider sync first; the journey's window is one second.
  const opened = await until(async () => {
    await f.pilot.detect();

    return (await stockCases())[0];
  }, 'the stock gap outlasts the sync window');
  expect(opened).toMatchObject({
    state: expect.not.stringMatching('resolved'),
  });
  expect(opened.subject.scope.slice(1)).toEqual(
    [f.manifest.connections.jtl, f.manifest.connections.shopify].sort(),
  );
  const evidence = await f.pilot.detection.exceptions.evidence(
    actor,
    opened.id,
  );
  // Both reads, the mapping and the agreement history the wait was based on.
  expect(evidence.map((item) => item.source?.provider).sort()).toEqual([
    'jtl',
    'shopify',
    undefined,
    undefined,
  ]);

  // The shop is wrong until the merchant repairs it; another pass keeps the case open.
  await f.pilot.detect();
  expect((await stockCases())[0]).toMatchObject({
    id: opened.id,
    state: expect.not.stringMatching('resolved'),
  });
  await f.call(`runs/operations/incidents/${id}/recover`, {});
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  const closed = await f.pilot.detection.exceptions.get(actor, opened.id);
  expect(closed.state).toBe('resolved');
  expect(closed.resolution).toMatchObject({
    kind: 'verification',
    outcome: 'passed',
  });
  expect(
    (await f.call('runs/operations/incidents')).find((item) => item.id === id),
  ).toMatchObject({ detection: { state: 'detected', caseId: opened.id } });
  expect(f.pilot.detectionErrors).toEqual([]);
});

test('stuck-fulfillment candidates carry the source references their import mapped', async (t) => {
  const f = await setupSimulator(t);
  const actor = await f.pilot.operator();
  await f.call('runs/operations/control', {
    action: 'order',
    lines: [{ sku: 'LUMA-001', quantity: 2 }],
  });
  await f.pilot.observe({ check: false });
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const open = await f.pilot.detectionSources.fulfillments(actor, {
    before: later,
    include: [],
    limit: 50,
  });
  expect(open.length).toBeGreaterThan(0);
  // Shipping work remains visible, but an observation time cannot establish progress.
  const unknownShipping = await f.db.owner.query(
    'SELECT entity_id,last_progress_at FROM orders_fulfillment_list WHERE tenant_id=$1 AND connection_id=$2 AND open',
    [f.manifest.organizationId, f.manifest.connections.starshipit],
  );
  expect(unknownShipping.rows.length).toBeGreaterThan(0);
  expect(
    unknownShipping.rows.every((row) => row.last_progress_at === null),
  ).toBe(true);
  expect(
    open.some(
      (work) => work.connectionId === f.manifest.connections.starshipit,
    ),
  ).toBe(false);
  const persistedShipping = unknownShipping.rows[0];
  expect(
    await f.pilot.detectionSources.fulfillments(actor, {
      before: new Date(Date.now() - 86_400_000).toISOString(),
      include: [
        {
          fulfillmentId: persistedShipping.entity_id,
          connectionId: f.manifest.connections.starshipit,
        },
      ],
      limit: 50,
    }),
  ).toEqual([
    expect.objectContaining({
      fulfillmentId: persistedShipping.entity_id,
      connectionId: f.manifest.connections.starshipit,
    }),
  ]);
  for (const work of open) {
    expect(work.connectionId).toBe(f.manifest.connections.shopify);
    expect(work.source).toMatchObject({
      resource: 'fulfillment',
      connectionId: work.connectionId,
    });
    expect(work.order.externalId).toMatch(/^gid:\/\/shopify\/Order\//);
    expect(work.lines.length).toBeGreaterThan(0);
  }
  // Work that progressed recently is not a candidate yet.
  expect(
    await f.pilot.detectionSources.fulfillments(actor, {
      before: new Date(Date.now() - 86_400_000).toISOString(),
      include: [],
      limit: 50,
    }),
  ).toEqual([]);
});

test('sustained malformed shop responses escalate after retries and close only after a complete scan', async (t) => {
  const f = await setupSimulator(t);
  const actor = await f.pilot.operator();
  const syncCases = async () =>
    (await f.pilot.detection.exceptions.list(actor)).filter(
      (incident) => incident.exceptionClass === 'sync_failure',
    );
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(await syncCases()).toEqual([]);

  // One unreadable response stays in automatic retry handling.
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'shopify',
      operation: 'products.read',
      kind: 'malformed',
      remaining: 100,
    },
  });
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(await syncCases()).toEqual([]);
  for (let attempt = 1; attempt < 5; attempt++)
    await f.pilot.observe({ check: false });
  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET failing_since=now()-interval '16 minutes'
     WHERE tenant_id=$1 AND connection_id=$2 AND error_code IS NOT NULL`,
    [f.manifest.organizationId, f.manifest.connections.shopify],
  );
  await f.pilot.detect();
  const [opened, ...others] = await syncCases();
  expect(others).toEqual([]);
  expect(opened).toMatchObject({
    severity: 'medium',
    subject: {
      subjectId: f.manifest.connections.shopify,
      scope: ['products.read'],
    },
  });
  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET failing_since=now()-interval '61 minutes'
     WHERE tenant_id=$1 AND connection_id=$2 AND error_code IS NOT NULL`,
    [f.manifest.organizationId, f.manifest.connections.shopify],
  );
  await f.pilot.detect();
  expect((await syncCases())[0]).toMatchObject({
    id: opened.id,
    severity: 'high',
  });

  // Recovery alone does not close the case; a complete scan after detection does.
  const [fault] = (await f.call('runs/operations')).faults;
  await f.call('runs/operations/control', { action: 'disable', id: fault.id });
  await f.pilot.detect();
  expect((await syncCases())[0].state).not.toBe('resolved');
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(
    await f.pilot.detection.exceptions.get(actor, opened.id),
  ).toMatchObject({
    state: 'resolved',
    resolution: { kind: 'verification', outcome: 'passed' },
  });
  expect(f.pilot.detectionErrors).toEqual([]);
});

test('reads simulated quantity edits into new immutable snapshots and exposes current units in order detail', async (t) => {
  const f = await setupSimulator(t);
  const connectionId = f.manifest.connections.shopify;
  const tenantId = f.manifest.organizationId;
  const cookie = await operatorCookie(f);
  await f.pilot.observe();
  const mapped = await f.db.owner.query(
    "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND external_id='gid://shopify/Order/1'",
    [tenantId, connectionId],
  );
  const orderId = mapped.rows[0].canonical_id;
  const detail = async () => {
    const response = await f.pilot.app.inject({
      method: 'GET',
      url: `/v1/organizations/${tenantId}/orders/${orderId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    return response.json();
  };
  const original = await f.db.owner.query(
    'SELECT s.id,s.document FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3',
    [tenantId, orderId, connectionId],
  );
  const before = original.rows[0];
  expect(
    (await detail()).sources.find(
      (source) => source.connectionId === connectionId,
    ).lines[0],
  ).toMatchObject({
    quantity: '2',
    currentQuantity: '2',
    cancelledQuantity: '0',
  });
  const provider = await f.call(
    'runs/operations/records/shopify?kind=LineItem&parent=1',
  );
  const lineId = provider.items[0].id;
  const hints = async () =>
    (
      await f.db.owner.query(
        'SELECT capabilities FROM connector_refresh_hints WHERE tenant_id=$1 AND connection_id=$2 ORDER BY received_at,event_key',
        [tenantId, connectionId],
      )
    ).rows;
  const hintCount = (await hints()).length;
  await f.call('runs/operations/control', {
    action: 'advance',
    milliseconds: 1000,
  });
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'shopify',
    command: {
      kind: 'order-edit',
      order: '1',
      lines: [{ lineItem: lineId, quantity: 1 }],
    },
  });
  await until(
    async () =>
      (await hints())
        .slice(hintCount)
        .some(
          (row) =>
            row.capabilities.length === 2 &&
            row.capabilities.includes('orders.read') &&
            row.capabilities.includes('fulfillment.read'),
        ),
    'order edit delivered its signed reread hint',
    20_000,
  );
  await f.pilot.observe();
  const edited = await detail();
  expect(
    edited.sources.find((source) => source.connectionId === connectionId)
      .lines[0],
  ).toMatchObject({
    quantity: '2',
    currentQuantity: '1',
    cancelledQuantity: '1',
    remainingQuantity: '1',
  });
  expect(
    edited.fulfillments.some((work) =>
      work.lines.some(
        (line) => line.quantity === '1' && line.remainingQuantity === '1',
      ),
    ),
  ).toBe(true);
  const current = await f.db.owner.query(
    'SELECT snapshot_id FROM orders_projections WHERE tenant_id=$1 AND entity_id=$2 AND connection_id=$3',
    [tenantId, orderId, connectionId],
  );
  expect(current.rows[0].snapshot_id).not.toBe(before.id);
  expect(
    (
      await f.db.owner.query(
        'SELECT document FROM orders_snapshots WHERE tenant_id=$1 AND id=$2',
        [tenantId, before.id],
      )
    ).rows[0].document,
  ).toEqual(before.document);
  await f.call('runs/operations/control', {
    action: 'advance',
    milliseconds: 1000,
  });
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'shopify',
    command: {
      kind: 'order-edit',
      order: '1',
      lines: [{ lineItem: lineId, quantity: 0 }],
    },
  });
  await until(
    async () => (await hints()).length > hintCount + 2,
    'line removal delivered refresh hints',
    20_000,
  );
  await f.pilot.observe();
  const removed = await detail();
  expect(
    removed.fulfillments.some((work) =>
      work.lines.some(
        (line) => line.quantity === '0' && line.remainingQuantity === '0',
      ),
    ),
  ).toBe(true);
  expect(
    removed.sources.find((source) => source.connectionId === connectionId)
      .lines[0],
  ).toMatchObject({
    quantity: '2',
    currentQuantity: '0',
    cancelledQuantity: '2',
    remainingQuantity: '0',
  });
});
