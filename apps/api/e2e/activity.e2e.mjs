import { randomUUID } from 'node:crypto';

import { workspacePolicyVersion } from '@luma/policies';
import { expect, it } from 'vitest';

import { seedActivity } from './activity-fixture.mjs';
import { database, signup, startApi } from './helpers.mjs';

it('reads deterministic tenant history, safe provenance, bounded filters and role-bound cursors', async (t) => {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const api = await startApi(t, db);
  const owner = await signup(api, 'activity-owner'),
    member = await signup(api, 'activity-member'),
    outsider = await signup(api, 'activity-outsider');
  const tenantId = (
    await api.request('/v1/organizations', {
      method: 'POST',
      cookie: owner.cookie,
      body: {
        name: 'Activity',
        slug: 'activity',
        dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
      },
      status: 201,
    })
  ).body.id;
  await db.owner.query(
    'INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,$4,now())',
    [randomUUID(), tenantId, member.userId, 'member'],
  );
  const fixture = await seedActivity(db, tenantId, owner.userId);
  const from = new Date(Date.now() - 86400000).toISOString(),
    to = new Date(Date.now() + 86400000).toISOString();
  const read = (extra = {}, cookie = owner.cookie, status = 200) =>
    api.request(
      `/v1/organizations/${tenantId}/activity?${new URLSearchParams({ from, to, limit: '10', ...extra })}`,
      { cookie, status },
    );
  const first = (await read()).body;
  expect(first.items).toHaveLength(10);
  expect(first.nextCursor).toBeTruthy();
  expect(JSON.stringify(first)).not.toContain('must-not-appear');
  expect(first.items[0].type).toBe('connection');
  const all = [...first.items];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = (await read({ cursor })).body;
    all.push(...page.items);
    cursor = page.nextCursor;
  }
  expect(new Set(all.map((i) => i.id)).size).toBe(36);
  expect(all.filter((i) => i.type !== 'connection').map((i) => i.id)).toEqual(
    [...fixture.ids].sort().reverse(),
  );
  expect((await read({ outcome: 'approved' })).body.items[0].outcome).toBe(
    'approved',
  );
  expect(
    (await read({ outcome: 'uncertain' })).body.items.every(
      (i) => i.verification === 'inconclusive',
    ),
  ).toBe(true);
  expect(
    (await read({ outcome: 'verified' })).body.items.every(
      (i) => i.verification === 'passed',
    ),
  ).toBe(true);
  expect((await read({ system: 'shopify' })).body.items).toEqual([]);
  expect(
    (await read({ system: 'jtl-cloud', connectionId: fixture.connectionId }))
      .body.items.length,
  ).toBe(10);
  expect((await read({ q: owner.userId })).body.items.length).toBe(10);
  // People are named, and found by name and email, without exposing other workspaces.
  expect(all.find((i) => i.actor.id === owner.userId)?.actor).toMatchObject({
    kind: 'member',
    name: 'activity-owner',
    email: 'activity-owner@example.test',
  });
  expect((await read({ q: 'ACTIVITY-OWNER' })).body.items.length).toBe(10);
  expect((await read({ q: 'activity-outsider' })).body.items).toEqual([]);
  expect((await read({ q: 'must-not-appear' })).body.items).toEqual([]);
  // The actor filter narrows by who recorded each event; `me` is each reader.
  const mine = (await read({ actor: 'me', limit: '100' })).body.items;
  expect(mine.length).toBeGreaterThan(30);
  expect(mine.every((i) => i.actor.id === owner.userId)).toBe(true);
  expect(
    (await read({ actor: owner.userId, limit: '100' })).body.items.map(
      (i) => i.id,
    ),
  ).toEqual(mine.map((i) => i.id));
  expect((await read({ actor: member.userId })).body.items).toEqual([]);
  expect((await read({ actor: 'me' }, member.cookie)).body.items).toEqual([]);
  expect(
    (await read({ actor: 'luma', limit: '100' })).body.items.every((i) =>
      ['luma', 'support'].includes(i.actor.kind),
    ),
  ).toBe(true);
  // Naming a person never reveals events the reader's role can't see.
  const ownersForMember = (
    await read({ actor: owner.userId, limit: '100' }, member.cookie)
  ).body;
  expect(ownersForMember.visibility).toBe('member');
  expect(
    ownersForMember.items.every(
      (i) => i.type !== 'connection' && i.type !== 'access',
    ),
  ).toBe(true);
  await read({ actor: 'everyone' }, owner.cookie, 400);
  const firstMine = (await read({ actor: 'me' })).body;
  expect(firstMine.nextCursor).toBeTruthy();
  await read(
    { actor: 'luma', cursor: firstMine.nextCursor },
    owner.cookie,
    400,
  );
  expect(
    (await read({}, member.cookie)).body.items.every(
      (i) => i.type !== 'connection',
    ),
  ).toBe(true);
  await read({ cursor: first.nextCursor }, member.cookie, 400);
  await read(
    { cursor: first.nextCursor, system: 'shopify' },
    owner.cookie,
    400,
  );
  await read({ limit: '101' }, owner.cookie, 400);
  await read({ from: '2020-01-01T00:00:00Z' }, owner.cookie, 400);
  await read({}, outsider.cookie, 404);
  await read({}, null, 401);
  // Audit delivery copies must not move the canonical event or duplicate it.
  const id = fixture.ids[0];
  await db.owner.query(
    'INSERT INTO policy_outbox(id,tenant_id,document,created_at) VALUES($1,$2,$3,$4)',
    [
      id,
      tenantId,
      {
        type: 'policy.approved',
        document: {
          proposalId: fixture.proposalId,
          createdAt: fixture.at,
          approverId: owner.userId,
          outcome: 'approved',
        },
      },
      fixture.at,
    ],
  );
  expect(
    (await read({ outcome: 'approved' })).body.items.map((i) => i.id),
  ).toEqual([id]);
  const timeline = (
    await api.request(
      `/v1/organizations/${tenantId}/exceptions/${fixture.exceptionId}/timeline?limit=100`,
      { cookie: owner.cookie },
    )
  ).body;
  expect(timeline.items.filter((event) => event.id === id)).toHaveLength(1);
  expect(timeline.items.find((event) => event.id === id).outcome).toBe(
    'approved',
  );
  expect((await read({ q: fixture.exceptionId })).body.items.length).toBe(10);
  expect((await read({ q: 'Order 1042' })).body.items.length).toBe(10);
  // A late event is discovered at the head without altering the already-issued page cursor.
  const lateId = randomUUID();
  const lateDoc = {
    id: lateId,
    tenantId,
    eventKey: lateId,
    eventType: 'execution.prepared',
    proposalId: fixture.proposalId,
    occurredAt: from,
    actor: { kind: 'service', id: 'executor' },
    details: { state: 'prepared' },
    evidenceRefs: [],
  };
  await db.owner.query(
    'INSERT INTO audit_entries(id,tenant_id,event_key,proposal_id,document) VALUES($1::uuid,$2,$1::text,$3,$4)',
    [lateId, tenantId, fixture.proposalId, lateDoc],
  );
  const latest = (await read()).body;
  expect(latest.items[0].id).toBe(lateId);
  expect(latest.items[0].outcome).toBe('attempted');
  expect(
    (await read({ cursor: first.nextCursor })).body.items.some(
      (event) => event.id === lateId,
    ),
  ).toBe(false);
  for (const [kind, outcome] of [
    ['human_disposition', 'manually_disposed'],
    ['verification', 'verified'],
  ]) {
    const resolutionId = randomUUID();
    await db.owner.query(
      'INSERT INTO exception_outbox(id,tenant_id,exception_id,document) VALUES($1,$2,$3,$4)',
      [
        resolutionId,
        tenantId,
        fixture.exceptionId,
        {
          type: 'exception.resolved',
          resolution: {
            kind,
            ...(kind === 'verification' ? { outcome: 'passed' } : {}),
            at: fixture.at,
            actorId: owner.userId,
            evidenceRefs: ['resolution:evidence'],
          },
        },
      ],
    );
    expect(
      (
        await read({ outcome, type: 'resolution', limit: '100' })
      ).body.items.some((event) => event.id === resolutionId),
    ).toBe(true);
  }

  // Actual exception producer shapes retain the attempt and its safe evidence.
  const incidentAttempt = randomUUID();
  const incidentEvent = randomUUID();
  await db.owner.query(
    'INSERT INTO exception_outbox(id,tenant_id,exception_id,document) VALUES($1,$2,$3,$4)',
    [
      incidentEvent,
      tenantId,
      fixture.exceptionId,
      {
        type: 'exception.verification_attempt',
        attemptId: incidentAttempt,
        phase: 'completed',
        actorId: owner.userId,
        occurredAt: fixture.at,
        outcome: 'failed',
        accepted: false,
        evidenceRefs: ['negative-read'],
      },
    ],
  );
  const attempts = (await read({ type: 'verification', limit: '100' })).body
    .items;
  expect(attempts.find((event) => event.id === incidentEvent)).toMatchObject({
    attemptId: incidentAttempt,
    verification: 'failed',
    verificationPhase: 'completed',
    outcome: 'uncertain',
    evidenceRefs: ['negative-read'],
    actor: { kind: 'member', id: owner.userId, name: 'activity-owner' },
  });
  const inconclusiveId = randomUUID();
  await db.owner.query(
    'INSERT INTO exception_outbox(id,tenant_id,exception_id,document) VALUES($1,$2,$3,$4)',
    [
      inconclusiveId,
      tenantId,
      fixture.exceptionId,
      {
        type: 'exception.verification_inconclusive',
        actorId: owner.userId,
        at: fixture.at,
        verification: { outcome: 'passed', evidenceRefs: ['unaccepted-read'] },
      },
    ],
  );
  expect(
    (await read({ outcome: 'uncertain', limit: '100' })).body.items.find(
      (event) => event.id === inconclusiveId,
    ),
  ).toMatchObject({
    verification: 'passed',
    outcome: 'uncertain',
    evidenceRefs: ['unaccepted-read'],
  });
  // An unresolved dispatch must stay uncertain after a negative reconciliation.
  const reconciliationId = randomUUID();
  await db.owner.query(
    'INSERT INTO audit_entries(id,tenant_id,event_key,proposal_id,document) VALUES($1::uuid,$2,$1::text,$3,$4)',
    [
      reconciliationId,
      tenantId,
      fixture.proposalId,
      {
        id: reconciliationId,
        tenantId,
        eventKey: reconciliationId,
        eventType: 'execution.reconciled',
        occurredAt: fixture.at,
        details: {
          state: 'unknown',
          verification: 'failed',
          dispatch: 'dispatched',
        },
      },
    ],
  );
  expect(
    (await read({ outcome: 'uncertain', limit: '100' })).body.items.find(
      (event) => event.id === reconciliationId,
    ),
  ).toMatchObject({
    executionState: 'unknown',
    verification: 'failed',
    outcome: 'uncertain',
  });
  // Verification/failure producers can commit without a completion outbox event.
  const unboundProposal = randomUUID(),
    executionId = randomUUID(),
    verificationId = randomUUID(),
    failureId = randomUUID();
  await db.owner.query(
    'INSERT INTO execution_intents(id,tenant_id,action_hash,document) VALUES($1,$2,$3,$4)',
    [
      unboundProposal,
      tenantId,
      'd'.repeat(64),
      { id: unboundProposal, tenantId },
    ],
  );
  // Only a workspace that allows writes reserves executions.
  await api.request(`/v1/organizations/${tenantId}/settings/write-mode`, {
    method: 'PATCH',
    cookie: owner.cookie,
    body: { commandId: randomUUID(), revision: 0, writeMode: 'writes_enabled' },
  });
  const policyDecisionId = randomUUID();
  // The reservation fence checks the decision against the workspace's effective approval
  // rule, which it reads in the workspace's context.
  const workspace = await db.owner.connect();
  try {
    await workspace.query('BEGIN');
    await workspace.query("SELECT set_config('app.tenant_id',$1,true)", [
      tenantId,
    ]);
    const rule = (
      await workspace.query(
        'SELECT workspace_requires_independent_approval() AS required, (SELECT policy_revision FROM workspace_settings WHERE tenant_id=$1) AS revision',
        [tenantId],
      )
    ).rows[0];
    await workspace.query(
      'INSERT INTO policy_decisions(id,tenant_id,proposal_id,action_hash,document) VALUES($1,$2,$3,$4,$5)',
      [
        policyDecisionId,
        tenantId,
        unboundProposal,
        'd'.repeat(64),
        {
          id: policyDecisionId,
          tenantId,
          proposalId: unboundProposal,
          outcome: 'allowed',
          policyVersion: workspacePolicyVersion(
            rule.revision ?? 0,
            rule.required,
          ),
        },
      ],
    );
    await workspace.query(
      "INSERT INTO executed_actions(id,tenant_id,proposal_id,idempotency_key,action_hash,state,document) VALUES($1,$2,$3,$4,$5,'prepared',$6)",
      [
        executionId,
        tenantId,
        unboundProposal,
        `v0:${unboundProposal}`,
        'd'.repeat(64),
        {
          id: executionId,
          tenantId,
          proposalId: unboundProposal,
          state: 'prepared',
          attempt: { policyDecisionId },
        },
      ],
    );
    await workspace.query('COMMIT');
  } catch (error) {
    await workspace.query('ROLLBACK');
    throw error;
  } finally {
    workspace.release();
  }
  for (const phase of ['pending', 'completed']) {
    await db.owner.query(
      'INSERT INTO execution_verifications(tenant_id,id,proposal_id,phase,document) VALUES($1,$2,$3,$4,$5)',
      [
        tenantId,
        verificationId,
        unboundProposal,
        phase,
        {
          id: verificationId,
          proposalId: unboundProposal,
          phase,
          actorId: owner.userId,
          startedAt: fixture.at,
          ...(phase === 'completed'
            ? { finishedAt: fixture.at, failure: { code: 'unavailable' } }
            : {}),
        },
      ],
    );
  }
  await db.owner.query(
    'INSERT INTO execution_failures(tenant_id,id,proposal_id,document) VALUES($1,$2,$3,$4)',
    [
      tenantId,
      failureId,
      unboundProposal,
      {
        id: failureId,
        proposalId: unboundProposal,
        occurredAt: fixture.at,
        phase: 'verification',
        code: 'unavailable',
        retry: 'reconcile',
        effect: 'unknown',
      },
    ],
  );
  const history = (await read({ type: 'verification', limit: '100' })).body
    .items;
  expect(
    history.find(
      (event) => event.id === `verification:${verificationId}:pending`,
    ),
  ).toMatchObject({
    verificationPhase: 'pending',
    outcome: 'uncertain',
    attemptId: verificationId,
  });
  expect(
    history.find(
      (event) => event.id === `verification:${verificationId}:completed`,
    ),
  ).toMatchObject({
    verificationPhase: 'completed',
    failureCode: 'unavailable',
    outcome: 'uncertain',
  });
  expect(
    history.find((event) => event.id === `failure:${failureId}`),
  ).toMatchObject({ failureCode: 'unavailable', outcome: 'uncertain' });
  // Issue-only events inherit recorded source connections even without any proposal.
  const sourceIssue = randomUUID(),
    sourceEvent = randomUUID(),
    evidenceKey = 'source-only-connection';
  const sourceIncident = (
    await db.owner.query(
      'SELECT document FROM exceptions WHERE tenant_id=$1 AND id=$2',
      [tenantId, fixture.exceptionId],
    )
  ).rows[0].document;
  await db.owner.query(
    "INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,'detected',$4)",
    [
      sourceIssue,
      tenantId,
      'c'.repeat(64),
      { ...sourceIncident, id: sourceIssue, fingerprint: 'c'.repeat(64) },
    ],
  );
  await db.owner.query(
    'INSERT INTO exception_sources(tenant_id,evidence_key,document) VALUES($1,$2,$3)',
    [
      tenantId,
      evidenceKey,
      { tenantId, key: evidenceKey, connectionId: fixture.connectionId },
    ],
  );
  await db.owner.query(
    'INSERT INTO exception_inputs(tenant_id,evidence_key,document) VALUES($1,$2,$3)',
    [tenantId, evidenceKey, {}],
  );
  await db.owner.query(
    'INSERT INTO exception_evidence(tenant_id,exception_id,evidence_key,fingerprint) VALUES($1,$2,$3,$4)',
    [tenantId, sourceIssue, evidenceKey, 'c'.repeat(64)],
  );
  await db.owner.query(
    'INSERT INTO exception_outbox(id,tenant_id,exception_id,document) VALUES($1,$2,$3,$4)',
    [
      sourceEvent,
      tenantId,
      sourceIssue,
      {
        type: 'exception.resolved',
        resolution: {
          kind: 'human_disposition',
          at: fixture.at,
          actorId: owner.userId,
          evidenceRefs: [evidenceKey],
        },
      },
    ],
  );
  expect(
    (
      await read({
        connectionId: fixture.connectionId,
        system: 'jtl-cloud',
        type: 'resolution',
        limit: '100',
      })
    ).body.items.find((event) => event.id === sourceEvent),
  ).toMatchObject({
    outcome: 'manually_disposed',
    connections: [{ id: fixture.connectionId, system: 'jtl-cloud' }],
  });
  await db.owner.query(
    'DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',
    [tenantId, member.userId],
  );
  await read({}, member.cookie, 404);
});
