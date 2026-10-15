import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { returnsFixture } from './returns-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

const evidence = (note) => ({ note, link: null });

it('counts partial returns once, keeps decisions apart from store records and enforces roles and tenants', async (t) => {
  const f = await settingsFixture(t);
  const r = await returnsFixture(t, f);
  const order = r.orders[1002];
  const casesPath = `${f.base}/orders/${order}/return-cases`;
  const post = (user, path, body, status = 200) =>
    f.request(user, path, 'POST', body, status);

  // #1002-R1 is an open store return for both units, so nothing is left to return.
  let available = await f.request(f.member, casesPath);
  expect(available.canManage).toBe(false);
  const source = available.sources.find((s) => s.connectionId === r.store);
  const line = source.lines[0];
  expect(line).toMatchObject({
    ordered: 2,
    inCases: 0,
    inStoreReturns: 2,
    returnable: 0,
  });
  expect(source.storeReturns).toEqual([
    expect.objectContaining({ id: r.returns.received, caseId: null }),
  ]);
  const open = (lines, sourceReturnId = null, id = randomUUID()) => ({
    id,
    connectionId: r.store,
    sourceReturnId,
    lines: lines.map((quantity) => ({
      orderLineId: line.orderLineId,
      quantity,
      reason: 'damaged',
      note: null,
    })),
  });

  // Members read but can't open cases; units the store return holds can't be claimed twice.
  await post(f.member, casesPath, open([1]), 403);
  await post(f.owner, casesPath, open([1]), 409);

  // Working the store return makes its units available to the case that links it.
  const linkedBody = open([1], r.returns.received);
  const first = await post(f.owner, casesPath, linkedBody);
  expect(first.case).toMatchObject({
    state: 'open',
    stage: 'awaiting_receipt',
    units: 1,
    sourceReturnId: r.returns.received,
    revision: 1,
  });
  expect(first.sourceReturn).toMatchObject({ id: r.returns.received });
  // An exact retry returns the same case; a changed body under the same ID is refused.
  expect((await post(f.owner, casesPath, linkedBody)).case.id).toBe(
    first.case.id,
  );
  await post(f.owner, casesPath, { ...linkedBody, lines: [] }, 400);
  await post(
    f.owner,
    casesPath,
    open([2], r.returns.received, linkedBody.id),
    409,
  );
  // One open case works a store return.
  await post(f.owner, casesPath, open([1], r.returns.received), 409);

  // A second partial return takes the remaining unit; a third finds nothing left.
  const second = await post(f.owner, casesPath, open([1]));
  await post(f.owner, casesPath, open([1]), 409);
  available = await f.request(f.member, casesPath);
  expect(
    available.sources.find((s) => s.connectionId === r.store).lines[0],
  ).toMatchObject({ ordered: 2, inCases: 2, inStoreReturns: 0, returnable: 0 });
  expect(available.cases.map((c) => c.id)).toEqual([
    first.case.id,
    second.case.id,
  ]);
  // Search is paged persisted data, and its cursor cannot be reused with another filter.
  const found = await f.request(
    f.member,
    `${f.base}/return-cases?q=%231002&limit=1`,
  );
  expect(found.items).toHaveLength(1);
  expect(found.items[0].orderNumber).toBe('#1002');
  expect(found.nextCursor).toBeTruthy();
  const next = await f.request(
    f.member,
    `${f.base}/return-cases?q=%231002&limit=1&cursor=${found.nextCursor}`,
  );
  expect(new Set([found.items[0].id, next.items[0].id])).toEqual(
    new Set([first.case.id, second.case.id]),
  );
  await f.request(
    f.member,
    `${f.base}/return-cases?q=other&limit=1&cursor=${found.nextCursor}`,
    'GET',
    undefined,
    422,
  );

  // A customer link uses the exact source order mapping, without copying contact details.
  const customerId = randomUUID();
  await f.db.owner.query(
    `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,state,contact_shared,address_shared,observed_at,observation_id) VALUES($1,$2,'customer-1002',$3,'enabled',false,false,now(),$4)`,
    [f.org.id, r.store, customerId, randomUUID()],
  );
  await f.db.owner.query(
    `INSERT INTO customer_orders(tenant_id,connection_id,order_scope_key,order_external_id,customer_external_id,observed_at) VALUES($1,$2,'','gid://shopify/Order/1002','customer-1002',now())`,
    [f.org.id, r.store],
  );
  expect(
    (
      await f.request(
        f.member,
        `${f.base}/return-cases?customerId=${customerId}`,
      )
    ).items
      .map((c) => c.id)
      .sort(),
  ).toEqual([first.case.id, second.case.id].sort());
  expect(
    (
      await f.request(
        f.member,
        `${f.base}/return-cases?customerId=${randomUUID()}`,
      )
    ).items,
  ).toEqual([]);

  // The store's own record is unchanged.
  const store = await f.request(
    f.member,
    `${f.base}/returns/${r.returns.received}`,
  );
  expect(store.item).toMatchObject({ quantity: '2', received: '2' });

  // Receipt, inspection and proposal are revision-checked decisions with evidence.
  const casePath = `${f.base}/return-cases/${first.case.id}`;
  await post(
    f.member,
    `${casePath}/receipt`,
    {
      commandId: randomUUID(),
      expectedRevision: 1,
      lines: [{ orderLineId: line.orderLineId, received: 1 }],
      evidence: evidence('Box dented'),
    },
    403,
  );
  // Inspection needs a receipt first.
  await post(
    f.owner,
    `${casePath}/inspection`,
    {
      commandId: randomUUID(),
      expectedRevision: 1,
      lines: [{ orderLineId: line.orderLineId, resellable: 1, damaged: 0 }],
      evidence: evidence(null),
    },
    409,
  );
  const receipt = {
    commandId: randomUUID(),
    expectedRevision: 1,
    lines: [{ orderLineId: line.orderLineId, received: 1 }],
    evidence: evidence('Box dented'),
  };
  let detail = await post(f.owner, `${casePath}/receipt`, receipt);
  expect(detail.case).toMatchObject({
    stage: 'awaiting_inspection',
    revision: 2,
  });
  expect(detail.lines[0]).toMatchObject({ received: 1, missing: 0 });
  // A retry of the same command changes nothing; a stale revision is refused.
  expect(
    (await post(f.owner, `${casePath}/receipt`, receipt)).case.revision,
  ).toBe(2);
  await post(
    f.owner,
    `${casePath}/receipt`,
    { ...receipt, commandId: randomUUID() },
    409,
  );
  await post(
    f.owner,
    `${casePath}/receipt`,
    {
      ...receipt,
      commandId: randomUUID(),
      expectedRevision: 2,
      lines: [{ orderLineId: line.orderLineId, received: 2 }],
    },
    422,
  );
  detail = await post(f.owner, `${casePath}/inspection`, {
    commandId: randomUUID(),
    expectedRevision: 2,
    lines: [{ orderLineId: line.orderLineId, resellable: 0, damaged: 1 }],
    evidence: { note: 'Torn seam', link: 'https://evidence.example/photo/1' },
  });
  expect(detail.lines[0]).toMatchObject({ resellable: 0, damaged: 1 });

  // A damaged unit can't be proposed for resellable restock.
  await post(
    f.owner,
    `${casePath}/proposal`,
    {
      commandId: randomUUID(),
      expectedRevision: 3,
      kind: 'refund',
      lines: [{ orderLineId: line.orderLineId, restock: 1 }],
      evidence: evidence(null),
    },
    409,
  );
  detail = await post(f.owner, `${casePath}/proposal`, {
    commandId: randomUUID(),
    expectedRevision: 3,
    kind: 'refund',
    lines: [{ orderLineId: line.orderLineId, restock: 0 }],
    evidence: evidence('Refund without restock'),
  });
  expect(detail.case).toMatchObject({
    stage: 'proposed',
    resolution: 'refund',
    revision: 4,
  });
  expect(detail.proposal).toMatchObject({
    kind: 'refund',
    by: { id: f.owner.id, name: 'Owner' },
  });
  expect(detail.inspection.evidence).toEqual({
    note: 'Torn seam',
    link: 'https://evidence.example/photo/1',
  });
  expect(detail.history.map((entry) => entry.kind)).toEqual([
    'opened',
    'receipt_recorded',
    'inspection_recorded',
    'resolution_proposed',
  ]);
  // The store system can't create returns from Luma; the case works without it.
  expect(detail.creationAvailability).toEqual({
    blocker: 'unsupported',
    connection: null,
  });

  // Only members who can manage returns can be assigned.
  await post(
    f.owner,
    `${casePath}/assignee`,
    { commandId: randomUUID(), expectedRevision: 4, assigneeId: f.member.id },
    409,
  );
  detail = await post(f.owner, `${casePath}/assignee`, {
    commandId: randomUUID(),
    expectedRevision: 4,
    assigneeId: f.owner.id,
  });
  expect(detail.case.assignee).toEqual({ id: f.owner.id, name: 'Owner' });

  // Read-only reviews keep the owning assignment in Waiting on others.
  const actionable = await f.request(
    f.member,
    `${f.base}/decisions?view=all&limit=100`,
  );
  expect(
    actionable.items.some((item) => item.id === `return-case:${first.case.id}`),
  ).toBe(false);
  const queue = await f.request(
    f.member,
    `${f.base}/decisions?view=all&scope=waiting&limit=100`,
  );
  const attention = queue.items.find(
    (item) => item.id === `return-case:${first.case.id}`,
  );
  expect(attention).toMatchObject({
    kind: 'return_case',
    response: 'view_only',
    owner: { kind: 'return_case', caseId: first.case.id },
    assignment: { assigneeId: f.owner.id, assignedBy: f.owner.id },
  });
  await post(
    f.owner,
    `${f.base}/decisions/assignments`,
    { decisionId: attention.id, assigneeId: f.owner.id, revision: 0 },
    404,
  );

  // Cancelling frees the units; the store return no longer counts through the cancelled case.
  const cancelled = await post(
    f.owner,
    `${f.base}/return-cases/${second.case.id}/cancel`,
    { commandId: randomUUID(), expectedRevision: 1, reason: 'Opened twice' },
  );
  expect(cancelled.case).toMatchObject({
    state: 'cancelled',
    stage: 'cancelled',
  });
  expect(
    (await f.request(f.member, casesPath)).sources.find(
      (s) => s.connectionId === r.store,
    ).lines[0],
  ).toMatchObject({ inCases: 1, returnable: 1 });

  // Audit evidence records every decision.
  const audit = await f.db.owner.query(
    `SELECT document->>'eventType' AS event_type FROM audit_entries
     WHERE tenant_id=$1 AND document->>'correlationId'=$2 ORDER BY created_at`,
    [f.org.id, first.case.id],
  );
  expect(audit.rows.map((row) => row.event_type)).toEqual([
    'return_case.opened',
    'return_case.receipt_recorded',
    'return_case.inspection_recorded',
    'return_case.resolution_proposed',
    'return_case.assigned',
  ]);

  // Another workspace can't read or change the case, even by ID.
  const other = await f.request(
    f.outsider,
    '/v1/organizations',
    'POST',
    { name: 'Elsewhere', slug: `elsewhere-${randomUUID().slice(0, 8)}` },
    201,
  );
  await f.request(
    f.outsider,
    `/v1/organizations/${other.id}/return-cases/${first.case.id}`,
    'GET',
    undefined,
    404,
  );
  await f.request(f.outsider, casePath, 'GET', undefined, 404);
  await post(
    f.outsider,
    `/v1/organizations/${other.id}/return-cases/${first.case.id}/cancel`,
    { commandId: randomUUID(), expectedRevision: 5, reason: 'Not mine' },
    404,
  );
  expect(
    (
      await f.request(
        f.outsider,
        `/v1/organizations/${other.id}/return-cases?q=%231002&limit=20`,
      )
    ).items,
  ).toEqual([]);
  const rows = await f.db.owner.query(
    'SELECT tenant_id FROM orders_return_cases WHERE id=$1',
    [first.case.id],
  );
  expect(rows.rows).toEqual([{ tenant_id: f.org.id }]);

  const role = await f.app.inject({
    method: 'POST',
    url: `${f.base}/roles`,
    headers: {
      origin: f.config.baseURL,
      cookie: f.owner.cookie,
      'x-command-id': randomUUID(),
    },
    payload: {
      name: 'Return reader',
      description: '',
      permissions: ['returns.read', 'orders.read'],
    },
  });
  expect(role.statusCode, role.body).toBe(201);
  await f.request(f.owner, `${f.base}/members/${f.membership.id}`, 'PATCH', {
    roleId: role.json().id,
  });
  await f.request(
    f.member,
    `${f.base}/return-cases?customerId=${customerId}`,
    'GET',
    undefined,
    403,
  );
  expect(
    (
      await f.request(f.member, `${f.base}/return-cases?openOnly=true`)
    ).items.map((c) => c.id),
  ).toEqual([first.case.id]);
  expect(
    (await f.request(f.member, `${f.base}/return-cases?openOnly=false`)).items,
  ).toHaveLength(2);
});

/** Signs in a seeded pilot user and returns their session cookie. */
async function login(f, email) {
  const response = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { email, password: f.password },
  });
  assert.equal(response.statusCode, 200, response.body);

  return []
    .concat(response.headers['set-cookie'])
    .map((v) => v.split(';')[0])
    .join('; ');
}

it('creates an approved return in JTL-Wawi once and verifies it with an independent read', async (t) => {
  const f = await setupSimulator(t);
  const org = f.manifest.organizationId;
  const jtl = f.manifest.connections.jtl;
  const requester = await login(f, 'pilot-operator@example.test');
  const approver = await login(f, 'pilot-requester@example.test');
  const request = async (
    url,
    body,
    { cookie = requester, status = 200 } = {},
  ) => {
    const response = await f.pilot.app.inject({
      method: body ? 'POST' : 'GET',
      url,
      headers: { cookie, origin: 'http://127.0.0.1:3000' },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(response.statusCode, status, response.body);

    return response.json();
  };
  const root = `/v1/organizations/${org}`;
  // An uncancelled JTL order that sync imported, with a line of at least two units.
  await f.pilot.observe({ check: false });
  const candidates = (
    await f.call('runs/operations/records/jtl?kind=sales-order&limit=100')
  ).items
    .map((item) => item.data)
    .filter(
      (order) =>
        !order.cancelled && order.lines.some((line) => line.quantity >= 2),
    );
  let orderId;
  let source;
  for (const candidate of candidates) {
    const mapped = await f.db.owner.query(
      `SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2
       AND resource='order' AND external_id=$3`,
      [org, jtl, candidate.id],
    );
    if (!mapped.rows[0]) continue;
    const available = await request(
      `${root}/orders/${mapped.rows[0].canonical_id}/return-cases`,
    );
    source = available.sources.find((s) => s.connectionId === jtl);
    if (source?.lines.some((line) => line.returnable >= 2)) {
      orderId = mapped.rows[0].canonical_id;
      break;
    }
  }
  assert.ok(orderId, 'No imported JTL order with two returnable units');
  const line = source.lines.find((item) => item.returnable >= 2);

  const opened = await request(`${root}/orders/${orderId}/return-cases`, {
    id: randomUUID(),
    connectionId: jtl,
    sourceReturnId: null,
    lines: [
      {
        orderLineId: line.orderLineId,
        quantity: 2,
        reason: 'defective',
        note: null,
      },
    ],
  });
  const caseId = opened.case.id;
  expect(opened.creationAvailability).toMatchObject({
    blocker: null,
    connection: { id: jtl },
  });
  const casePath = `${root}/return-cases/${caseId}`;
  const options = await request(`${casePath}/creation-options`);
  expect(options.warehouses.length).toBeGreaterThan(0);
  expect(options.reasons.length).toBeGreaterThan(0);
  const choice = {
    warehouse: {
      externalId: options.warehouses[0].externalId,
      scopeKey: options.warehouses[0].scopeKey,
    },
    reason: {
      externalId: options.reasons[0].externalId,
      scopeKey: options.reasons[0].scopeKey,
    },
  };
  const jtlReturns = async () =>
    (
      await f.call('runs/operations/records/jtl?kind=return&limit=100')
    ).items.map((item) => item.data);

  // Observe-only records the request and sends nothing.
  const settings = await request(`${root}/settings`, undefined, {
    cookie: approver,
  });
  const writeMode = async (mode, revision) => {
    const response = await f.pilot.app.inject({
      method: 'PATCH',
      url: `${root}/settings/write-mode`,
      headers: { cookie: approver, origin: 'http://127.0.0.1:3000' },
      payload: { commandId: randomUUID(), writeMode: mode, revision },
    });
    expect(response.statusCode, response.body).toBe(200);

    return response.json();
  };
  const observing = await writeMode(
    'observe_only',
    settings.workspace.revision,
  );
  const observed = await request(`${casePath}/creations`, {
    id: randomUUID(),
    ...choice,
  });
  expect(observed.creation).toMatchObject({
    state: 'not_executed',
    observeOnly: true,
    canApprove: false,
  });
  expect(await jtlReturns()).toEqual([]);
  await writeMode('writes_enabled', observing.workspace.revision);

  // A second person approves; the requester can't approve their own request.
  const requestBody = { id: randomUUID(), ...choice };
  const requested = await request(`${casePath}/creations`, requestBody);
  expect(requested.creation).toMatchObject({
    state: 'approval_required',
    canApprove: false,
  });
  // A retry of the same request is the same request; a second live request is refused.
  expect(
    (await request(`${casePath}/creations`, requestBody)).creation.id,
  ).toBe(requestBody.id);
  await request(
    `${casePath}/creations`,
    { id: randomUUID(), ...choice },
    { status: 409 },
  );
  const decision = {
    decisionId: requested.creation.decisionId,
    outcome: 'approved',
  };
  await request(`${casePath}/creations/${requestBody.id}/decision`, decision, {
    status: 409,
  });
  const review = await request(casePath, undefined, { cookie: approver });
  expect(review.creation.canApprove).toBe(true);
  const approved = await request(
    `${casePath}/creations/${requestBody.id}/decision`,
    decision,
    { cookie: approver },
  );
  expect(approved.creation).toMatchObject({
    state: 'created',
    failure: null,
    decidedBy: { name: expect.any(String) },
  });
  expect(approved.creation.externalReturn?.number).toBeTruthy();
  expect(approved.case.externalNumber).toBe(
    approved.creation.externalReturn.number,
  );
  expect(approved.creationAvailability.blocker).toBe('created');

  // JTL holds exactly one return for the case, marked so it can be found again.
  const created = (await jtlReturns()).filter(
    (item) => item.externalNumber === `luma-rc:${caseId}`,
  );
  expect(created).toHaveLength(1);
  expect(created[0].lines).toEqual([
    expect.objectContaining({ quantity: 2, credit: false }),
  ]);

  // Sending or checking again never creates a second return.
  await request(
    `${casePath}/creations/${requestBody.id}/send`,
    {},
    { status: 409 },
  );
  await request(`${casePath}/creations/${requestBody.id}/check`, {});
  await request(
    `${casePath}/creations`,
    { id: randomUUID(), ...choice },
    { status: 409 },
  );
  expect(
    (await jtlReturns()).filter(
      (item) => item.externalNumber === `luma-rc:${caseId}`,
    ),
  ).toHaveLength(1);
  const executed = await f.db.owner.query(
    'SELECT count(*)::int AS n FROM executed_actions WHERE tenant_id=$1',
    [org],
  );
  expect(executed.rows[0].n).toBeGreaterThanOrEqual(1);
  const history = (await request(casePath)).history.map((entry) => entry.kind);
  expect(history).toEqual(
    expect.arrayContaining([
      'creation_requested',
      'creation_approved',
      'creation_created',
    ]),
  );
});

it('creates and approves Shopify returns through policy, links imported units once and reconciles independently', async (t) => {
  const f = await setupSimulator(t);
  const org = f.manifest.organizationId,
    connectionId = f.manifest.connections.shopify;
  const requester = await login(f, 'pilot-operator@example.test');
  const approver = await login(f, 'pilot-requester@example.test');
  const root = `/v1/organizations/${org}`;
  const request = async (path, body, cookie = requester, status = 200) => {
    const response = await f.pilot.app.inject({
      method: body ? 'POST' : 'GET',
      url: `${root}${path}`,
      headers: { cookie, origin: 'http://127.0.0.1:3000' },
      ...(body ? { payload: body } : {}),
    });
    expect(response.statusCode, response.body).toBe(status);

    return response.json();
  };
  const variants = (
    await f.call('runs/operations/records/shopify?kind=ProductVariant&limit=10')
  ).items;
  const oldOrders = new Set(
    (
      await f.call('runs/operations/records/shopify?kind=Order&limit=100')
    ).items.map((o) => o.id),
  );
  const command = (command) =>
    f.call('runs/operations/control', {
      action: 'command',
      instance: 'shopify',
      command,
    });
  await f.call('runs/operations/control', {
    action: 'order',
    shop: 'shopify',
    lines: [{ sku: variants[0].data.sku, quantity: 2 }],
  });
  const providerOrderId = (
    await f.call('runs/operations/records/shopify?kind=Order&limit=100')
  ).items.find((o) => !oldOrders.has(o.id)).id;
  await command({
    kind: 'fulfill',
    order: providerOrderId,
    carrier: 'DHL',
    trackingNumber: 'return-test',
    trackingUrl: 'https://example.test/tracking',
  });
  await f.pilot.observe({ check: false });
  const mapped = await f.db.owner.query(
    "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND external_id=$3",
    [org, connectionId, `gid://shopify/Order/${providerOrderId}`],
  );
  const orderId = mapped.rows[0].canonical_id;
  const available = await request(`/orders/${orderId}/return-cases`);
  const line = available.sources.find((s) => s.connectionId === connectionId)
    .lines[0];
  const opened = await request(`/orders/${orderId}/return-cases`, {
    id: randomUUID(),
    connectionId,
    sourceReturnId: null,
    lines: [
      {
        orderLineId: line.orderLineId,
        quantity: 1,
        reason: 'size_or_fit',
        note: null,
      },
    ],
  });
  expect(opened.creationAvailability.blocker).toBeNull();
  const path = `/return-cases/${opened.case.id}`;
  const options = await request(`${path}/creation-options`);
  const choice = {
    warehouse: { externalId: 'shopify', scopeKey: '' },
    reason: { externalId: 'SIZE_TOO_SMALL', scopeKey: '' },
  };
  expect(options.warehouses).toContainEqual(
    expect.objectContaining(choice.warehouse),
  );
  const pending = await request(`${path}/creations`, {
    id: randomUUID(),
    ...choice,
  });
  expect(pending.creation).toMatchObject({
    state: 'approval_required',
    operation: 'create',
  });
  await request(
    `${path}/creations/${pending.creation.id}/decision`,
    { decisionId: pending.creation.decisionId, outcome: 'approved' },
    requester,
    409,
  );
  const created = await request(
    `${path}/creations/${pending.creation.id}/decision`,
    { decisionId: pending.creation.decisionId, outcome: 'approved' },
    approver,
  );
  expect(created.creation).toMatchObject({
    state: 'created',
    operation: 'create',
  });
  await f.pilot.observe({ check: false });
  const bound = await request(path);
  expect(bound.case.sourceReturnId).toBeTruthy();
  const counted = await request(`/orders/${orderId}/return-cases`);
  expect(
    counted.sources.find((s) => s.connectionId === connectionId).lines[0],
  ).toMatchObject({ inCases: 1, inStoreReturns: 0, returnable: 1 });
  // A customer requests the remaining unit; Luma approves that request, without creating another return.
  const providerLines = (
    await f.call('runs/operations/records/shopify?kind=LineItem&limit=100')
  ).items.filter((l) => l.data.order === providerOrderId);
  await command({
    kind: 'return',
    order: providerOrderId,
    lines: [{ lineItem: providerLines[0].id, quantity: 1 }],
    reason: 'Wrong size',
  });
  await f.pilot.observe({ check: false });
  const next = await request(`/orders/${orderId}/return-cases`);
  const source = next.sources.find((s) => s.connectionId === connectionId);
  const sourceReturn = source.storeReturns.find(
    (r) => r.status === 'requested',
  );
  const second = await request(`/orders/${orderId}/return-cases`, {
    id: randomUUID(),
    connectionId,
    sourceReturnId: sourceReturn.id,
    lines: [
      {
        orderLineId: line.orderLineId,
        quantity: 1,
        reason: 'size_or_fit',
        note: null,
      },
    ],
  });
  const secondPath = `/return-cases/${second.case.id}`;
  const approval = await request(`${secondPath}/creations`, {
    id: randomUUID(),
    ...choice,
  });
  expect(approval.creation.operation).toBe('approve');
  const approved = await request(
    `${secondPath}/creations/${approval.creation.id}/decision`,
    { decisionId: approval.creation.decisionId, outcome: 'approved' },
    approver,
  );
  expect(approved.creation).toMatchObject({
    state: 'created',
    operation: 'approve',
  });
  expect(
    (
      await f.call('runs/operations/records/shopify?kind=Return&limit=100')
    ).items.filter((r) => r.data.order === providerOrderId),
  ).toHaveLength(2);
});
