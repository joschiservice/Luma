import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildRuntimeApp } from '@luma/application-runtime';
import { Pool } from 'pg';
import { test } from 'vitest';

import {
  correctionFixture,
  stockItem,
  stockLocation,
} from './shopify-inventory-fixture.mjs';

test('ERP authority, separate approval, one dispatch, reconciliation and tenant isolation', async (t) => {
  const { f, admin, call, target, mutations, delayVerification, stock } =
    await correctionFixture(t);
  await call(f.member, 'inspect', target, 403);
  await call(f.outsider, 'inspect', target, 404);
  await call(null, 'inspect', target, 401);
  await call(
    f.owner,
    'preview',
    { ...target, requestId: randomUUID(), quantity: 999 },
    422,
  );
  await call(
    f.owner,
    'preview',
    {
      ...target,
      connectionId: target.sourceConnectionId,
      sourceConnectionId: target.connectionId,
      requestId: randomUUID(),
    },
    404,
  );
  const preview = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  assert.equal(preview.state, 'approval_required');
  assert.equal(preview.before.available, 12);
  assert.equal(preview.before.source.available, 9);
  // Recover a preview whose admission persisted before its decision was linked.
  await f.db.owner.query(
    'UPDATE shopify_inventory_corrections SET decision_id=NULL WHERE tenant_id=$1 AND id=$2',
    [f.org.id, preview.id],
  );
  const recovered = await call(f.owner, 'check', { id: preview.id });
  assert.ok(recovered.decisionId);
  assert.equal(recovered.id, preview.id);
  assert.equal(recovered.state, 'approval_required');
  // Needs you projects the same app-owned decision for each reader.
  // Waiting decisions keep one ID per target; checks of a sent change use the attempt's ID.
  const decision = async (user) =>
    (
      await f.request(user, `${f.base}/decisions?domain=inventory&scope=all`)
    ).items.find(
      (item) =>
        item.id ===
          `shopify:inventory_correction:${target.positionId}:${target.connectionId}` ||
        item.id === `shopify:inventory_correction:${preview.id}`,
    );
  const pending = await decision(admin);
  assert.equal(pending.reason, 'approval');
  assert.equal(pending.response, 'decide');
  assert.equal(pending.urgency, 'normal');
  assert.deepEqual(pending.owner, {
    kind: 'app_inventory',
    appId: 'shopify',
    positionId: target.positionId,
  });
  assert.deepEqual(pending.record, {
    kind: 'position',
    id: target.positionId,
  });
  assert.ok(pending.change.some((fact) => fact.value === 'Set to 9 (-3)'));
  assert.equal((await decision(f.owner)).response, 'awaiting_other');
  assert.equal(await decision(f.member), undefined);
  await f.request(f.outsider, `${f.base}/decisions`, 'GET', undefined, 404);
  await call(f.owner, 'execute', { id: preview.id }, 409);
  await call(f.owner, 'approve', { id: preview.id, outcome: 'approved' }, 409);
  await call(admin, 'approve', { id: preview.id, outcome: 'approved' });
  await call(admin, 'approve', { id: preview.id, outcome: 'approved' }, 409);
  assert.equal((await decision(f.owner)).response, 'run');
  assert.equal((await decision(admin)).response, 'view_only');
  await call(admin, 'execute', { id: preview.id }, 403);
  delayVerification(true);
  await Promise.all([
    call(f.owner, 'execute', { id: preview.id }),
    call(f.owner, 'execute', { id: preview.id }),
  ]);
  assert.equal(mutations.length, 1);
  const accepted = await call(f.owner, 'check', { id: preview.id });
  assert.equal(accepted.acceptance, 'accepted');
  assert.equal(accepted.state, 'recovery_required');
  const unverified = await decision(f.owner);
  assert.equal(unverified.reason, 'recovery');
  assert.equal(unverified.response, 'check');
  assert.deepEqual(mutations[0].variables.input.quantities, [
    {
      inventoryItemId: stockItem,
      locationId: stockLocation,
      changeFromQuantity: 12,
      quantity: 9,
    },
  ]);
  assert.ok(mutations[0].query.includes('@idempotent'));
  delayVerification(false);
  const verified = await call(f.owner, 'check', { id: preview.id });
  assert.equal(verified.state, 'verified');
  assert.equal(await decision(f.owner), undefined);
  assert.equal(mutations.length, 1);
  const answered = await f.request(
    admin,
    `${f.base}/decisions/${encodeURIComponent(pending.id)}`,
  );
  assert.equal(answered.response, 'view_only');
  assert.equal(answered.outcome.state, 'approved');
  assert.equal(answered.outcome.next, 'verified');
  assert.equal(answered.outcome.actorEmail, admin.email);
  assert.equal(answered.record.id, target.positionId);
  assert.equal(
    await f.request(
      f.member,
      `${f.base}/decisions/${encodeURIComponent(pending.id)}`,
    ),
    null,
  );
  await f.request(
    f.outsider,
    `${f.base}/decisions/${encodeURIComponent(pending.id)}`,
    'GET',
    undefined,
    404,
  );
  const wrongConnection = `shopify:inventory_correction:${target.positionId}:${randomUUID()}`;
  assert.equal(
    await f.request(
      admin,
      `${f.base}/decisions/${encodeURIComponent(wrongConnection)}`,
    ),
    null,
  );
  const stockDetail = await f.request(
    f.owner,
    `${f.base}/inventory/${target.positionId}`,
  );
  assert.equal(
    stockDetail.position.sources.find((s) => s.connectionId === stock.erp)
      .available,
    '9',
  );
  // Canonical projections stay observations, not optimistic mutation results.
  assert.equal(
    stockDetail.position.sources.find(
      (s) => s.connectionId === target.connectionId,
    ).available,
    '12',
  );
  const evidence = await f.db.owner.query(
    'SELECT kind,document FROM shopify_inventory_evidence WHERE tenant_id=$1',
    [f.org.id],
  );
  const acceptance = evidence.rows.find((r) => r.kind === 'acceptance');
  assert.equal(acceptance.document.adapterVersion, 'shopify-inventory/1');
  assert.match(acceptance.document.dispatchIdentity, /shopify-inventory\/1/);
  assert.equal(
    acceptance.document.records[0].resource,
    'inventory_adjustment_group',
  );
  for (const { document } of evidence.rows.filter(
    (r) => r.kind === 'observation',
  )) {
    assert.equal(document.adapterVersion, 'shopify-inventory/1');
    assert.equal(document.completeness, 'complete');
  }
  const audit = await f.db.owner.query(
    "SELECT document->>'eventType' AS event FROM audit_entries WHERE tenant_id=$1 AND document->>'proposalId'=$2",
    [f.org.id, preview.id],
  );
  assert.ok(audit.rows.some((r) => r.event === 'execution.completed'));
  assert.ok(audit.rows.some((r) => r.event === 'execution.reconciled'));
  const pool = new Pool({ connectionString: f.db.runtimeUrl });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [
        randomUUID(),
      ]);
      for (const table of [
        'shopify_inventory_corrections',
        'shopify_inventory_claims',
        'shopify_inventory_evidence',
      ]) {
        assert.equal(
          (await client.query(`SELECT count(*)::int AS n FROM ${table}`))
            .rows[0].n,
          0,
        );
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});

test('correlates an exact correction echo after restart while preserving unrelated changes', async (t) => {
  const { f, admin, call, target, mutations, syncStock, changeAvailable } =
    await correctionFixture(t);
  const preview = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  await call(admin, 'approve', { id: preview.id, outcome: 'approved' });
  await call(f.owner, 'execute', { id: preview.id });
  const reference = `luma://inventory-corrections/v0:${preview.id}`;
  assert.equal(mutations[0].variables.input.referenceDocumentUri, reference);
  assert.equal(
    (await call(f.owner, 'check', { id: preview.id })).state,
    'verified',
  );
  const echo = await syncStock();
  assert.equal(echo[0].data.available, '9');
  assert.equal(echo[0].data.writeAttribution.referenceDocumentUri, reference);
  assert.equal(echo[0].data.writeAttribution.quantityMatches, true);
  let detail = await f.request(
    f.owner,
    `${f.base}/inventory/${target.positionId}`,
  );
  const source = detail.position.sources.find(
    (s) => s.connectionId === target.connectionId,
  );
  assert.equal(source.writeAttribution.quantityMatches, true);
  assert.equal(source.available, '9');
  assert.equal(
    (await call(f.owner, 'inspect', target)).snapshot.writeAttribution
      .referenceDocumentUri,
    reference,
  );
  await changeAvailable(8);
  const changed = await syncStock();
  assert.equal(changed[0].data.available, '8');
  assert.equal(changed[0].data.writeAttribution.quantityMatches, false);
  detail = await f.request(f.owner, `${f.base}/inventory/${target.positionId}`);
  assert.ok(detail.position.differences.includes('available'));
  assert.equal(
    detail.position.sources.find((s) => s.connectionId === target.connectionId)
      .available,
    '8',
  );
  assert.ok(
    detail.history.entries.some(
      (entry) => entry.writeAttribution?.quantityMatches === true,
    ),
  );
  assert.ok(
    detail.history.entries.some(
      (entry) => entry.writeAttribution?.quantityMatches === false,
    ),
  );
  assert.equal(mutations.length, 1);
  await f.request(
    f.outsider,
    `${f.base}/inventory/${target.positionId}`,
    'GET',
    undefined,
    404,
  );
});

test('a newer ERP read of the same quantity keeps an approved correction valid', async (t) => {
  const { f, admin, call, target, mutations, stock } =
    await correctionFixture(t);
  const preview = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  await call(admin, 'approve', { id: preview.id, outcome: 'approved' });
  // Detection rereads linked stock often; the same authoritative quantity is not a change.
  await stock.stock({
    connectionId: stock.erp,
    external: '77',
    location: stockLocation,
    amount: '9',
  });
  const executed = await call(f.owner, 'execute', { id: preview.id });
  assert.equal(executed.acceptance, 'accepted');
  assert.equal(mutations.length, 1);
  assert.equal(
    (await call(f.owner, 'check', { id: preview.id })).state,
    'verified',
  );
});

test('an authority override invalidates a reviewed correction before dispatch', async (t) => {
  const { f, admin, call, target, mutations } = await correctionFixture(t);
  const preview = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  await call(admin, 'approve', { id: preview.id, outcome: 'approved' });
  await f.request(f.owner, `${f.base}/source-authority`, 'POST', {
    commandId: randomUUID(),
    revision: 0,
    group: 'inventory_stock',
    connectionId: target.connectionId,
  });
  await call(f.owner, 'execute', { id: preview.id }, 409);
  assert.equal(mutations.length, 0);
  const history = await f.request(
    f.owner,
    `${f.base}/source-authority/history`,
  );
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].connectionId, target.connectionId);
});

test('source freshness, ambiguous mappings, source changes and provider CAS stop writes', async (t) => {
  const { f, admin, call, target, mutations, stock, race, level } =
    await correctionFixture(t);
  const fresh = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  await call(admin, 'approve', { id: fresh.id, outcome: 'approved' });
  await stock.stock({
    connectionId: stock.erp,
    external: '77',
    location: stockLocation,
    amount: '8',
  });
  await call(f.owner, 'execute', { id: fresh.id }, 409);
  assert.equal(mutations.length, 0);
  await stock.stock({
    connectionId: stock.erp,
    external: '77',
    location: stockLocation,
    amount: '9',
    time: new Date(Date.now() - 6 * 60_000).toISOString(),
  });
  // Projection retains the newer source; make that latest observation stale without a new canonical write.
  await f.db.owner.query(
    `UPDATE inventory_snapshots SET document=jsonb_set(document,'{observedAt}',to_jsonb($3::text)) WHERE tenant_id=$1 AND connection_id=$2`,
    [f.org.id, stock.erp, new Date(Date.now() - 6 * 60_000).toISOString()],
  );
  await call(f.owner, 'preview', { ...target, requestId: randomUUID() }, 409);
  await stock.stock({
    connectionId: stock.erp,
    external: '77',
    location: stockLocation,
    amount: '9',
  });
  await stock.stock({
    connectionId: target.connectionId,
    external: 'gid://shopify/InventoryItem/2',
    location: stockLocation,
    amount: '12',
  });
  await call(f.owner, 'preview', { ...target, requestId: randomUUID() }, 409);
  await f.db.owner.query(
    'DELETE FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND external_id=$3',
    [f.org.id, target.connectionId, 'gid://shopify/InventoryItem/2'],
  );
  const cas = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  await call(admin, 'approve', { id: cas.id, outcome: 'approved' });
  race();
  const refused = await call(f.owner, 'execute', { id: cas.id });
  assert.equal(refused.state, 'denied');
  assert.equal(refused.acceptance, 'not_sent');
  assert.equal(
    level.quantities.find((q) => q.name === 'available').quantity,
    10,
  );
  assert.equal(mutations.length, 1);
});

test('lost write response survives reload and only reconciles, without replay', async (t) => {
  const {
    f,
    admin,
    call,
    target,
    mutations,
    loseResponse,
    delayVerification,
    connectionsConfig,
  } = await correctionFixture(t);
  const preview = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  await call(admin, 'approve', { id: preview.id, outcome: 'approved' });
  loseResponse();
  delayVerification(true);
  const uncertain = await call(f.owner, 'execute', { id: preview.id });
  assert.equal(uncertain.state, 'uncertain');
  const restarted = await buildRuntimeApp(
    f.config,
    {},
    undefined,
    undefined,
    connectionsConfig,
  );
  try {
    const retry = await restarted.inject({
      method: 'POST',
      url: `${f.base}/apps/shopify/inventory-correction-execute`,
      headers: { origin: f.config.baseURL, cookie: f.owner.cookie },
      payload: { id: preview.id },
    });
    assert.equal(retry.statusCode, 200, retry.body);
  } finally {
    await restarted.close();
  }
  assert.equal(mutations.length, 1);
  await call(f.owner, 'preview', { ...target, requestId: randomUUID() }, 409);
  const reload = await call(f.owner, 'inspect', target);
  assert.equal(reload.runs[0].state, 'uncertain');
  delayVerification(false);
  const verified = await call(f.owner, 'check', { id: preview.id });
  assert.equal(verified.state, 'uncertain');
  assert.equal(
    (await call(f.owner, 'inspect', target)).snapshot.writeAttribution,
    null,
  );
  assert.equal(mutations.length, 1);
});

test.for(['solo', 'team preference'])(
  'allows requester approval for Shopify stock correction with %s',
  async (mode, t) => {
    const { f, call, target, mutations } = await correctionFixture(t);
    if (mode === 'solo') {
      for (const member of (await f.request(f.owner, `${f.base}/members`))
        .items)
        if (member.userId !== f.owner.id)
          await f.request(
            f.owner,
            `${f.base}/members/${member.id}`,
            'DELETE',
            undefined,
            204,
          );
    } else {
      const snapshot = await f.request(f.owner, `${f.base}/settings`);
      await f.request(
        f.owner,
        `${f.base}/settings/approvals`,
        'PATCH',
        f.command({
          revision: snapshot.workspace.policyRevision,
          alwaysRequireApproval: false,
          requireIndependentApproval: false,
        }),
      );
    }
    const preview = await call(f.owner, 'preview', {
      ...target,
      requestId: randomUUID(),
    });
    assert.equal(preview.state, 'approval_required');
    assert.equal(preview.canApprove, true);
    const item = (
      await f.request(f.owner, `${f.base}/decisions?domain=inventory&scope=all`)
    ).items.find((item) => item.requesterId === f.owner.id);
    assert.equal(item.response, 'decide');
    await call(f.owner, 'approve', { id: preview.id, outcome: 'approved' });
    await call(f.owner, 'execute', { id: preview.id });
    await call(f.owner, 'execute', { id: preview.id });
    assert.equal(mutations.length, 1);
    assert.equal(
      (await call(f.owner, 'check', { id: preview.id })).state,
      'verified',
    );
    const approval = (
      await f.db.owner.query(
        'SELECT document FROM policy_approvals WHERE tenant_id=$1 AND proposal_id=$2',
        [f.org.id, preview.id],
      )
    ).rows[0].document;
    assert.equal(approval.approverId, f.owner.id);
    assert.equal(approval.requesterId, f.owner.id);
    assert.ok(approval.policyVersion.endsWith(':self-approval'));
  },
);

test('changed detection limits require a fresh stock correction review before dispatch', async (t) => {
  const { f, admin, call, target, mutations } = await correctionFixture(t);
  const preview = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  await call(admin, 'approve', { id: preview.id, outcome: 'approved' });
  const { workspace } = await f.request(f.owner, `${f.base}/settings`);
  await f.request(
    f.owner,
    `${f.base}/settings/workspace`,
    'PATCH',
    f.command({
      revision: workspace.revision,
      name: workspace.name,
      timezone: workspace.timezone,
      detection: { ...workspace.detection, inventoryTolerance: '2' },
    }),
  );
  assert.equal(
    (await call(f.owner, 'check', { id: preview.id })).state,
    'denied',
  );
  await call(f.owner, 'execute', { id: preview.id }, 409);
  assert.equal(mutations.length, 0);
  const refreshed = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  assert.notEqual(refreshed.id, preview.id);
  assert.equal(refreshed.state, 'approval_required');
});
