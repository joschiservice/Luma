import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildApp } from '@luma/application-runtime';
import { createSourceEnvironmentService } from '@luma/connections/composition';
import {
  createObservability,
  createTenantDatabase,
} from '@luma/platform/composition';
import { completeAutonomy, reserveAutonomy } from '@luma/policies/composition';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { caseWorkflowFixture } from './case-workflows-fixture.mjs';
import { until } from './helpers.mjs';
import { settingsFixture } from './settings-fixture.mjs';

const flags = () =>
  createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: {
      'scoped-autonomy': true,
      'action-review-diffs': true,
    },
  });
const scope = (tenantId, dailyQuantity = '2') => ({
  capability: 'procurement.follow-up.record',
  connectionIds: [tenantId],
  supplierIds: [],
  locationIds: [],
  recordIds: [],
  unit: 'follow_up',
  perActionQuantity: '1',
  dailyQuantity,
  money: null,
  maxEvidenceAgeSeconds: 300,
});

it('serializes exact aggregate quantity and exposure with dispatch, persists circuit demotion, and isolates tenants', async (t) => {
  const f = await settingsFixture(t, undefined, { observability: flags() });
  const path = `${f.base}/autonomy`;
  const draft = {
    commandId: randomUUID(),
    id: randomUUID(),
    expectedRevision: 0,
    name: 'Bounded follow-ups',
    scope: {
      ...scope(f.org.id),
      money: { currency: 'EUR', perAction: '0.600001', daily: '1.000001' },
    },
    reason: 'Review internal responsibility limits',
  };
  const saved = await f.request(f.owner, path, 'POST', draft);
  expect(await f.request(f.owner, path, 'POST', draft)).toEqual(saved);
  await f.request(
    f.owner,
    path,
    'POST',
    { ...draft, name: 'Rebound command' },
    409,
  );
  const assisted = await f.request(
    f.owner,
    `${path}/${saved.id}/control`,
    'POST',
    {
      commandId: randomUUID(),
      expectedRevision: saved.revision,
      kind: 'assist',
      reason: 'Review each proposed note independently',
    },
  );
  await f.request(f.member, path, 'GET', undefined, 403);
  await f.request(f.outsider, path, 'GET', undefined, 404);
  const pool = new Pool({ connectionString: f.db.runtimeUrl, max: 5 });
  t.onTestFinished(() => pool.end());
  const db = createTenantDatabase(pool);
  const now = new Date();
  const facts = {
    recordId: randomUUID(),
    connectionId: f.org.id,
    supplierId: null,
    locationId: null,
    quantity: '1',
    unit: 'follow_up',
    exposure: { amount: '0.600001', currency: 'EUR' },
    observedAt: now.toISOString(),
    complete: true,
    environment: 'synthetic',
  };
  const admission = {
    policyId: assisted.id,
    revision: assisted.revision,
    scopeHash: assisted.scopeHash,
    facts,
  };
  const ids = [randomUUID(), randomUUID()];
  const attempts = await Promise.allSettled(
    ids.map((id) =>
      db.transaction(f.org.id, (tx) =>
        reserveAutonomy(tx, f.org.id, id, admission, now),
      ),
    ),
  );
  expect(
    attempts.filter((attempt) => attempt.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(
    attempts.find((attempt) => attempt.status === 'rejected').reason.message,
  ).toContain('exposure limit');
  const usage = (
    await f.db.owner.query(
      'SELECT quantity::text,exposure::text,proposal_id FROM autonomy_reservations WHERE tenant_id=$1',
      [f.org.id],
    )
  ).rows;
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    quantity: '1.000000',
    exposure: '0.600001',
  });
  await expect(
    db
      .transaction(randomUUID(), (tx) =>
        tx.query('SELECT * FROM autonomy_policies WHERE id=$1', [saved.id]),
      )
      .then((result) => result.rows),
  ).resolves.toEqual([]);
  // A committed circuit change uses the same transaction fence as the reservation.
  await db.transaction(f.org.id, (tx) =>
    completeAutonomy(
      tx,
      f.org.id,
      usage[0].proposal_id,
      admission,
      { dispatch: 'uncertain', verification: 'unknown' },
      now,
    ),
  );
  const [paused] = (await f.request(f.owner, path)).policies;
  expect(paused).toMatchObject({
    revision: assisted.revision + 1,
    paused: true,
    mode: 'manual',
    circuitReason: 'uncertain_dispatch',
  });
  await expect(
    db.transaction(f.org.id, (tx) =>
      reserveAutonomy(tx, f.org.id, randomUUID(), admission, now),
    ),
  ).rejects.toMatchObject({ statusCode: 409 });
  const revisions = await f.db.owner.query(
    'SELECT revision FROM autonomy_policy_revisions WHERE tenant_id=$1 AND policy_id=$2 ORDER BY revision',
    [f.org.id, saved.id],
  );
  expect(revisions.rows.map((row) => row.revision)).toEqual([1, 2, 3]);
  await f.request(
    f.owner,
    `${path}/${saved.id}/control`,
    'POST',
    {
      commandId: randomUUID(),
      expectedRevision: paused.revision,
      kind: 'promote',
      reason: 'Synthetic results are not earned live evidence',
    },
    409,
  );
  // Quantity budgeting is independent of optional money: only two contenders may reserve.
  const quantityDraft = {
    ...draft,
    commandId: randomUUID(),
    id: randomUUID(),
    scope: scope(f.org.id),
  };
  const quantityPolicy = await f.request(f.owner, path, 'POST', quantityDraft);
  const quantityAssisted = await f.request(
    f.owner,
    `${path}/${quantityPolicy.id}/control`,
    'POST',
    {
      commandId: randomUUID(),
      expectedRevision: 1,
      kind: 'assist',
      reason: 'Review notes',
    },
  );
  const quantityAdmission = {
    policyId: quantityAssisted.id,
    revision: 2,
    scopeHash: quantityAssisted.scopeHash,
    facts: { ...facts, exposure: null },
  };
  const quantities = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      db.transaction(f.org.id, (tx) =>
        reserveAutonomy(
          tx,
          f.org.id,
          randomUUID(),
          quantityAdmission,
          new Date(),
        ),
      ),
    ),
  );
  expect(
    quantities.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(2);
  expect(
    quantities.filter((result) => result.status === 'rejected'),
  ).toHaveLength(2);
});

it('routes the native supplier workflow through scoped review, refreshes changed owner inputs without carrying approval, and records once after independent consent', async (t) => {
  const f = await caseWorkflowFixture(t, {
    observability: flags(),
    detection: { followUps: { supplierWaitSeconds: 30 } },
  });
  const tenantId = f.manifest.organizationId;
  await f.pilot.observe({ check: false });
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'jtl',
    command: { kind: 'supplier-profile', supplierId: '1', profile: 'silent' },
  });
  const supplier = await f.request('/procurement/suppliers', {
    id: randomUUID(),
    name: 'Nordwind Textil',
    externalReferences: [],
  });
  const jtl = f.manifest.connections.jtl;
  const external = (
    await f.request(`/procurement/purchasing-connections/${jtl}/suppliers`)
  ).items.find((item) => item.externalId === '1');
  await f.request(`/procurement/suppliers/${supplier.id}/link`, {
    expectedRevision: 1,
    link: { connectionId: jtl, externalId: '1', scopeKey: external.scopeKey },
    confirmationHours: 1,
  });
  const policy = await f.request(
    '/autonomy',
    {
      commandId: randomUUID(),
      id: randomUUID(),
      expectedRevision: 0,
      name: 'Reviewed supplier notes',
      scope: { ...scope(tenantId, '10'), supplierIds: [supplier.id] },
      reason: 'Limit follow-ups to this supplier',
    },
    { cookie: f.approverCookie },
  );
  await f.request(
    `/autonomy/${policy.id}/control`,
    {
      commandId: randomUUID(),
      expectedRevision: 1,
      kind: 'assist',
      reason: 'Require independent note review',
    },
    { cookie: f.approverCookie },
  );
  await f.activate('supplier-follow-up');
  const sku = (
    await f.db.owner.query(
      "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='sku' AND external_id='2'",
      [tenantId, jtl],
    )
  ).rows[0].canonical_id;
  const order = await f.request('/procurement/purchase-orders', {
    id: randomUUID(),
    supplierId: supplier.id,
    reference: 'PO-GOVERNED-1',
    lines: [
      {
        id: randomUUID(),
        sku,
        description: 'Cotton tote',
        quantity: 10,
        unit: 'each',
      },
    ],
  });
  const submitted = await f.request(
    `/procurement/purchase-orders/${order.id}/submissions`,
    {
      id: randomUUID(),
      requestedDeliveryDate: new Date(Date.now() + 7 * 86400000)
        .toISOString()
        .slice(0, 10),
    },
  );
  const sent = await f.request(
    `/procurement/submissions/${submitted.id}/decision`,
    { decisionId: submitted.decisionId, outcome: 'approved' },
    { cookie: f.approverCookie },
  );
  expect(sent.state).toBe('submitted');
  await f.db.owner.query(
    "UPDATE procurement_submissions SET document=jsonb_set(document,'{submittedAt}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2",
    [tenantId, submitted.id, new Date(Date.now() - 7200000).toISOString()],
  );
  await f.tick();
  let first;
  await until(
    async () => {
      first = (await f.request('/autonomy/follow-ups')).items.find(
        (item) => item.orderId === order.id,
      );

      return first?.review.outcome === 'approval_required';
    },
    'native internal follow-up awaits scope approval',
    30000,
  ).catch(async (cause) => {
    throw new Error(
      JSON.stringify({
        runs: await f.runs('supplier-follow-up'),
        pending: await f.request('/autonomy/follow-ups'),
        record: await f.request(
          `/procurement/purchase-orders/${order.id}/record`,
        ),
      }),
      { cause },
    );
  });
  expect(
    (await f.request(`/procurement/purchase-orders/${order.id}/record`))
      .followUps,
  ).toEqual([]);
  const queue = (
    await f.request('/decisions?domain=procurement', undefined, {
      cookie: f.approverCookie,
    })
  ).items;
  const native = queue.find(
    (item) => item.owner.followUpProposalId === first.id,
  );
  expect(native).toBeDefined();
  expect(native.diff).toMatchObject({
    canonicalOutcome: 'internal_record',
    records: expect.arrayContaining([
      expect.objectContaining({
        system: 'luma',
        kind: 'purchase_order',
        id: order.id,
      }),
    ]),
  });
  await f.request(
    `/autonomy/follow-ups/${first.id}/response`,
    { decisionId: first.review.decisionId, outcome: 'approved' },
    { status: 403 },
  );
  await f.request(
    `/autonomy/follow-ups/${first.id}/response`,
    { decisionId: first.review.decisionId, outcome: 'approved' },
    { cookie: f.approverCookie },
  );
  // Simulate an owner revision between review and dispatch, while attention key stays equal.
  await f.db.owner.query(
    "UPDATE procurement_purchase_orders SET document=jsonb_set(jsonb_set(document,'{revision}',to_jsonb((document->>'revision')::integer+1)),'{lines,0,quantity}',to_jsonb(11)) WHERE tenant_id=$1 AND id=$2",
    [tenantId, order.id],
  );
  const stale = (await f.request('/autonomy/follow-ups')).items.find(
    (item) => item.id === first.id,
  );
  expect(stale.review.stale).toBe(true);
  const renewed = await f.request(`/autonomy/follow-ups/${first.id}/refresh`, {
    commandId: randomUUID(),
  });
  expect(renewed.approvalRetained).toBe(false);
  expect(renewed.proposal).toMatchObject({
    previousProposalId: first.id,
    workflowRunId: first.workflowRunId,
    followUpId: first.followUpId,
    key: first.key,
    orderRevision: first.orderRevision + 1,
  });
  expect(renewed.proposal.orderScopeFingerprint).not.toBe(
    first.orderScopeFingerprint,
  );
  expect(renewed.review).toMatchObject({
    outcome: 'approval_required',
    stale: false,
  });
  expect(renewed.review.decisionId).not.toBe(first.review.decisionId);
  await f.request(
    `/autonomy/follow-ups/${renewed.proposal.id}/response`,
    { decisionId: first.review.decisionId, outcome: 'approved' },
    { cookie: f.approverCookie, status: 409 },
  );
  await f.request(
    `/autonomy/follow-ups/${renewed.proposal.id}/response`,
    { decisionId: renewed.review.decisionId, outcome: 'approved' },
    { cookie: f.approverCookie },
  );
  let recorded;
  await until(
    async () => {
      await f.tick();
      recorded = await f.request(
        `/procurement/purchase-orders/${order.id}/record`,
      );

      return recorded.followUps.length === 1;
    },
    'renewed internal note independently verified',
    30000,
  );
  expect(recorded.followUps[0]).toMatchObject({
    id: first.followUpId,
    response: 'following_up',
  });
  await f.tick();
  expect(
    (await f.request(`/procurement/purchase-orders/${order.id}/record`))
      .followUps,
  ).toHaveLength(1);
  expect(
    (await f.request('/autonomy/follow-ups')).items.some(
      (item) => item.orderId === order.id,
    ),
  ).toBe(false);
});

it('retains reviewed source declarations with exact source revisions, retry-safe audit and tenant-isolated reads', async (t) => {
  const f = await settingsFixture(t, undefined, { observability: flags() });
  const pool = new Pool({ connectionString: f.db.runtimeUrl, max: 5 });
  t.onTestFinished(() => pool.end());
  const db = createTenantDatabase(pool);
  const connectionId = randomUUID();
  let synthetic = false,
    released = true;
  const c = {
    id: connectionId,
    tenantId: f.org.id,
    label: 'Reviewed source fixture',
    target: { kind: 'jtl-cloud', baseUrl: 'https://fixture.example.test' },
    provider: 'jtl',
    status: 'active',
    permissions: ['purchase-orders.read'],
    granted: ['purchase-orders.read'],
    version: 1,
    credentialVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await f.db.owner.query(
    'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
    [f.org.id, connectionId, c, 'fixture-only-encrypted-secret'],
  );
  const observations = [
    {
      id: randomUUID(),
      provider: 'jtl',
      resource: 'purchase_order',
      sourceRevision: 'fixture-revision-1',
      observedAt: new Date().toISOString(),
    },
  ];
  // Controlled owner-port evidence tests the declaration contract, not real provider efficacy.
  const sourceEnvironments = createSourceEnvironmentService(db, {
    refreshContext: f.identity.service.refreshContext,
    connections: {
      list: (context) =>
        db.transaction(context.tenantId, async (tx) =>
          (
            await tx.query(
              'SELECT document FROM connector_installations WHERE tenant_id=$1',
              [context.tenantId],
            )
          ).rows.map((r) => r.document),
        ),
    },
    enabled: async () => released,
    synthetic: () => synthetic,
    installed: async () => true,
    readEvidence: async () => observations,
  });
  const app = buildApp(
    {},
    {
      identity: f.identity.service,
      sourceEnvironments,
      trustedOrigins: [f.config.baseURL],
    },
  );
  t.onTestFinished(() => app.close());
  const path = `${f.base}/source-environments`;

  async function request(user, url, method = 'GET', body, status = 200) {
    const response = await app.inject({
      method,
      url,
      headers: {
        origin: f.config.baseURL,
        ...(user ? { cookie: user.cookie } : {}),
      },
      ...(body === undefined ? {} : { payload: body }),
    });
    assert.equal(response.statusCode, status, response.body);

    return response.json();
  }

  const ownerContext = await f.identity.service.resolveTenant(
    { cookie: f.owner.cookie },
    f.org.id,
    randomUUID(),
  );
  expect((await request(f.owner, path)).items[0].environment).toBe('unknown');
  await request(f.member, path, 'GET', undefined, 403);
  await request(f.outsider, path, 'GET', undefined, 404);
  await request(undefined, path, 'GET', undefined, 401);
  const review = await request(
    f.owner,
    `${path}/${connectionId}/review`,
    'POST',
  );
  expect((await request(f.owner, path)).items[0].environment).toBe('unknown');
  const command = {
    commandId: randomUUID(),
    expectedRevision: 0,
    reviewId: review.id,
    liveOperationsConfirmed: true,
    reason: 'Explicit fixture operational-use declaration',
  };
  const declaration = await request(
    f.owner,
    `${path}/${connectionId}`,
    'POST',
    command,
  );
  expect(
    await request(f.owner, `${path}/${connectionId}`, 'POST', command),
  ).toEqual(declaration);
  await request(
    f.owner,
    `${path}/${connectionId}`,
    'POST',
    { ...command, reason: 'Different content' },
    409,
  );
  const live = (await request(f.owner, path)).items[0];
  expect(live).toMatchObject({
    environment: 'live',
    provenance: {
      basis: 'reviewed_workspace_declaration',
      declarationRevision: 1,
      credentialVersion: 1,
      evidenceId: review.id,
    },
  });
  const retained = (
    await f.db.owner.query(
      'SELECT document FROM connector_source_commands WHERE tenant_id=$1 AND id=$2',
      [f.org.id, command.commandId],
    )
  ).rows[0].document;
  expect(retained).toMatchObject({
    actorId: f.owner.id,
    reason: command.reason,
    revision: 1,
    review: { observations },
  });
  await expect(
    db
      .transaction(randomUUID(), (tx) =>
        tx.query(
          'SELECT * FROM connector_source_environments WHERE connection_id=$1',
          [connectionId],
        ),
      )
      .then((r) => r.rows),
  ).resolves.toEqual([]);
  await expect(
    db.transaction(f.org.id, (tx) =>
      tx.query(
        'UPDATE connector_source_commands SET document=$3 WHERE tenant_id=$1 AND id=$2',
        [f.org.id, command.commandId, {}],
      ),
    ),
  ).rejects.toBeDefined();
  // A source/credential change invalidates the declaration and all original proposal source evidence.
  await f.db.owner.query(
    "UPDATE connector_installations SET version=2,document=jsonb_set(jsonb_set(document,'{version}','2'::jsonb),'{credentialVersion}','2'::jsonb) WHERE tenant_id=$1 AND id=$2",
    [f.org.id, connectionId],
  );
  expect(
    (await sourceEnvironments.classify(ownerContext, connectionId)).environment,
  ).toBe('unknown');
  await request(
    f.owner,
    `${path}/${connectionId}`,
    'POST',
    { ...command, commandId: randomUUID(), expectedRevision: 1 },
    409,
  );
  const nextReview = await request(
    f.owner,
    `${path}/${connectionId}/review`,
    'POST',
  );
  const renewed = await request(f.owner, `${path}/${connectionId}`, 'POST', {
    ...command,
    commandId: randomUUID(),
    expectedRevision: 1,
    reviewId: nextReview.id,
  });
  expect(renewed.revision).toBe(2);
  expect(
    (await sourceEnvironments.classify(ownerContext, connectionId)).provenance,
  ).toMatchObject({
    credentialVersion: 2,
    declarationRevision: 2,
    evidenceId: nextReview.id,
  });
  const revoke = {
    commandId: randomUUID(),
    expectedRevision: 2,
    reviewId: null,
    liveOperationsConfirmed: false,
    reason: 'Revoke reviewed use',
  };
  await request(f.owner, `${path}/${connectionId}`, 'POST', revoke);
  expect(
    (await sourceEnvironments.classify(ownerContext, connectionId)).environment,
  ).toBe('unknown');
  expect(
    (
      await f.db.owner.query(
        'SELECT document FROM connector_source_commands WHERE tenant_id=$1 AND id=$2',
        [f.org.id, command.commandId],
      )
    ).rows[0].document,
  ).toEqual(retained);
  synthetic = true;
  expect(
    (await sourceEnvironments.classify(ownerContext, connectionId)).environment,
  ).toBe('synthetic');
  await request(
    f.owner,
    `${path}/${connectionId}/review`,
    'POST',
    undefined,
    409,
  );
  synthetic = false;
  released = false;
  expect(await request(f.owner, path)).toEqual({ available: false, items: [] });
  await request(
    f.owner,
    `${path}/${connectionId}/review`,
    'POST',
    undefined,
    403,
  );
});
