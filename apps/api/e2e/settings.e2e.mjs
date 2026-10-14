import { randomUUID } from 'node:crypto';

import { createTenantDatabase } from '@luma/platform/composition';
import { createPolicies } from '@luma/policies/composition';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { invitationProof, settingsFixture } from './settings-fixture.mjs';

it('persists settings, reconciles commands, enforces tenant roles and serializes last-owner changes', async (t) => {
  const f = await settingsFixture(t);
  const { request, owner, member, outsider, base, command } = f;
  const original = await request(owner, `${base}/settings`);
  expect(original.preferences).toEqual({
    issues: false,
    connections: false,
    morningBrief: false,
    morningBriefTime: '08:00',
    revision: 0,
  });
  const write = command({
    name: 'Northstar Japan',
    timezone: 'Asia/Tokyo',
    detection: {
      inventoryTolerance: '2.5',
      propagationSeconds: 900,
      oversellPropagationSeconds: 30,
      stuckSeconds: 3600,
    },
    revision: 0,
  });
  await request(member, `${base}/settings/workspace`, 'PATCH', write, 403);
  await request(outsider, `${base}/settings`, 'GET', undefined, 404);
  await request(
    owner,
    `${base}/settings/workspace`,
    'PATCH',
    { ...write, timezone: 'not/a-zone' },
    400,
  );
  await request(
    owner,
    `${base}/settings/workspace`,
    'PATCH',
    {
      ...write,
      detection: { ...write.detection, oversellPropagationSeconds: -1 },
    },
    400,
  );
  const saved = await request(
    owner,
    `${base}/settings/workspace`,
    'PATCH',
    write,
  );
  expect(saved.workspace).toMatchObject({
    name: 'Northstar Japan',
    timezone: 'Asia/Tokyo',
    detection: write.detection,
    revision: 1,
  });
  expect(
    await request(owner, `${base}/settings/workspace`, 'PATCH', write),
  ).toEqual(saved);
  expect(
    await request(owner, `${base}/settings/commands/${write.commandId}`),
  ).toEqual({ committed: true });
  expect(
    await request(member, `${base}/settings/commands/${write.commandId}`),
  ).toEqual({ committed: false });
  await request(
    owner,
    `${base}/settings/workspace`,
    'PATCH',
    command({ ...write, commandId: randomUUID(), name: 'Stale' }),
    409,
  );
  await request(
    owner,
    `${base}/settings/workspace`,
    'PATCH',
    { ...write, name: 'Reuse' },
    409,
  );
  await request(
    member,
    `${base}/settings/approvals`,
    'PATCH',
    command({ revision: 0, alwaysRequireApproval: true }),
    403,
  );
  const approvalRule = command({
    revision: 0,
    alwaysRequireApproval: false,
    replenishmentApproval: {
      separateSend: false,
      threshold: { amount: '5000', currency: 'AUD' },
    },
  });
  await request(
    member,
    `${base}/settings/approvals`,
    'PATCH',
    approvalRule,
    403,
  );
  const policy = await request(
    owner,
    `${base}/settings/approvals`,
    'PATCH',
    approvalRule,
  );
  expect(policy.workspace).toMatchObject({
    policyRevision: 1,
    replenishmentApproval: approvalRule.replenishmentApproval,
    detection: write.detection,
  });
  expect(
    await request(owner, `${base}/settings/approvals`, 'PATCH', approvalRule),
  ).toEqual(policy);
  expect((await request(owner, `${base}/settings`)).workspace).toMatchObject(
    policy.workspace,
  );
  await request(owner, `${base}/members/${f.membership.id}`, 'PATCH', {
    roleId: 'owner',
  });
  const members = (await request(owner, `${base}/members`)).items;
  const ownerMembership = members.find((m) => m.userId === owner.id);
  const results = await Promise.all(
    [ownerMembership.id, f.membership.id].map((memberId) =>
      f.app.inject({
        method: 'PATCH',
        url: `${base}/members/${memberId}`,
        headers: { origin: 'http://localhost:3000', cookie: owner.cookie },
        payload: { roleId: 'member' },
      }),
    ),
  );
  expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  expect(results.filter((r) => [403, 409].includes(r.statusCode))).toHaveLength(
    1,
  );
  expect(
    (
      await f.db.owner.query(
        "SELECT count(*) FROM memberships WHERE tenant_id=$1 AND role='owner'",
        [f.org.id],
      )
    ).rows[0].count,
  ).toBe('1');
  const audit = await f.db.owner.query(
    'SELECT event_type,before_value,after_value FROM workspace_access_events WHERE tenant_id=$1',
    [f.org.id],
  );
  expect(
    audit.rows.some(
      (row) =>
        row.event_type === 'workspace.updated' &&
        row.after_value.timezone === 'Asia/Tokyo',
    ),
  ).toBe(true);
  expect(JSON.stringify(audit.rows)).not.toContain('cookie');
});

it('delivers expiring invitations and rejects wrong-email, wrong-workspace, old, revoked and reused links', async (t) => {
  const f = await settingsFixture(t);
  const { request, owner, member, outsider, base, command } = f;
  await request(
    member,
    `${base}/settings/invitations`,
    'POST',
    command({ email: outsider.email, roleId: 'admin' }),
    403,
  );
  await request(
    owner,
    `${base}/settings/invitations`,
    'POST',
    command({ email: member.email, roleId: 'member' }),
    409,
  );
  f.setFail(true);
  const input = command({ email: outsider.email, roleId: 'admin' });
  const invite = await request(
    owner,
    `${base}/settings/invitations`,
    'POST',
    input,
  );
  expect(
    await request(owner, `${base}/settings/invitations`, 'POST', input),
  ).toEqual(invite);
  await request(
    owner,
    `${base}/settings/invitations`,
    'POST',
    command({ email: outsider.email, roleId: 'member' }),
    409,
  );
  for (let i = 0; i < 5; i++) {
    await f.drain();
    await f.db.owner.query(
      "UPDATE workspace_mail SET next_attempt_at=now() WHERE state='queued'",
    );
  }
  expect(
    (await request(owner, `${base}/settings/invitations`)).items[0].delivery,
  ).toBe('failed');
  await request(outsider, base + '/context', 'GET', undefined, 404);
  f.setFail(false);
  await request(
    owner,
    `${base}/settings/invitations/${invite.id}`,
    'POST',
    command({ action: 'resend', generation: 1 }),
  );
  await f.drain();
  const old = invitationProof([...f.messages.values()][0]);
  await request(member, '/v1/invitations/accept', 'POST', old, 404);
  await request(
    outsider,
    '/v1/invitations/accept',
    'POST',
    { ...old, organizationId: randomUUID() },
    404,
  );
  await f.db.owner.query(
    "UPDATE workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
    [invite.id],
  );
  await request(outsider, '/v1/invitations/accept', 'POST', old, 404);
  await request(
    owner,
    `${base}/settings/invitations/${invite.id}`,
    'POST',
    command({ action: 'resend', generation: 2 }),
  );
  await f.drain();
  const proof = invitationProof([...f.messages.values()].at(-1));
  await request(outsider, '/v1/invitations/accept', 'POST', old, 404);
  expect(
    await request(outsider, '/v1/invitations/preview', 'POST', proof),
  ).toMatchObject({
    role: { id: 'admin', name: 'Admin' },
    email: outsider.email,
  });
  const accepted = await Promise.all(
    [1, 2].map(() =>
      f.app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { origin: 'http://localhost:3000', cookie: outsider.cookie },
        payload: proof,
      }),
    ),
  );
  expect(accepted.map((r) => r.statusCode).sort()).toEqual([200, 404]);
  const target = (await request(owner, `${base}/members`)).items.find(
    (m) => m.userId === outsider.id,
  );
  expect(target.role.id).toBe('admin');
  await request(
    owner,
    `${base}/members/${target.id}`,
    'DELETE',
    undefined,
    204,
  );
  await request(outsider, '/v1/invitations/accept', 'POST', proof, 404);
  const next = await request(
    owner,
    `${base}/settings/invitations`,
    'POST',
    command({ email: outsider.email, roleId: 'member' }),
  );
  await f.drain();
  const revoked = invitationProof([...f.messages.values()].at(-1));
  await request(
    owner,
    `${base}/settings/invitations/${next.id}`,
    'POST',
    command({ action: 'revoke', generation: 1 }),
  );
  await request(outsider, '/v1/invitations/accept', 'POST', revoked, 404);
});

it('sends deduplicated opt-in notifications, cancels muted or removed recipients and retains bounded retries', async (t) => {
  const f = await settingsFixture(t);
  const { request, member, owner, base, command, org } = f;
  await request(
    member,
    `${base}/settings/notifications`,
    'PATCH',
    command({ revision: 0, issues: true, connections: true }),
  );
  const id = randomUUID();
  const doc = {
    id,
    tenantId: org.id,
    state: 'awaiting_approval',
    fingerprint: 'a'.repeat(64),
    occurrenceCount: 1,
    exceptionClass: 'sync_failure',
    severity: 'high',
  };
  await f.db.owner.query(
    "INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,'awaiting_approval',$4)",
    [id, org.id, doc.fingerprint, doc],
  );
  await f.db.owner.query(
    'UPDATE exceptions SET version=version+1 WHERE id=$1',
    [id],
  );
  await f.drain();
  await f.drain();
  expect(f.messages.size).toBe(1);
  expect([...f.messages.values()][0]).toMatchObject({ to: member.email });
  expect([...f.messages.values()][0].text).toContain(
    `/exceptions/${id}/detail`,
  );
  const connection = randomUUID();
  await f.db.owner.query(
    'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
    [
      org.id,
      connection,
      { tenantId: org.id, id: connection, version: 1, status: 'active' },
      'sensitive-provider-secret',
    ],
  );
  const emit = async (version) =>
    f.db.owner.query(
      "INSERT INTO connector_lifecycle_events(tenant_id,connection_id,version,event,actor_id,status,credential_version) VALUES($1,$2,$3,'degraded',$4,'degraded',1) ON CONFLICT DO NOTHING",
      [org.id, connection, version, owner.id],
    );
  await emit(1);
  await emit(1);
  await f.drain();
  expect(f.messages.size).toBe(2);
  expect([...f.messages.values()][1].text).not.toContain(
    'sensitive-provider-secret',
  );
  await emit(2);
  await request(
    member,
    `${base}/settings/notifications`,
    'PATCH',
    command({ revision: 1, issues: false, connections: false }),
  );
  await f.drain();
  expect(f.messages.size).toBe(2);
  await request(
    member,
    `${base}/settings/notifications`,
    'PATCH',
    command({ revision: 2, issues: true, connections: true }),
  );
  await emit(3);
  await request(
    owner,
    `${base}/members/${f.membership.id}`,
    'DELETE',
    undefined,
    204,
  );
  await f.drain();
  expect(f.messages.size).toBe(2);
  const test = command({});
  await request(owner, `${base}/settings/notifications/test`, 'POST', test);
  await request(owner, `${base}/settings/notifications/test`, 'POST', test);
  await f.drain();
  expect(f.messages.size).toBe(3);
  // A restarted worker must never retry an uncertain delivery outside the provider's deduplication window.
  await f.db.owner.query(
    "UPDATE workspace_mail SET state='queued',first_attempt_at=now()-interval '25 hours',next_attempt_at=now() WHERE kind='test'",
  );
  await f.drain();
  expect(f.messages.size).toBe(3);
  expect((await request(owner, `${base}/settings`)).lastTest.state).toBe(
    'failed',
  );
});

it('strengthens platform policy, versions decisions and rejects stale independent approvals', async (t) => {
  const f = await settingsFixture(t);
  const { request, owner, member, base, command } = f;
  await request(owner, `${base}/members/${f.membership.id}`, 'PATCH', {
    roleId: 'admin',
  });
  const pool = new Pool({ connectionString: f.db.runtimeUrl });
  t.onTestFinished(() => pool.end());
  const policies = createPolicies(
    createTenantDatabase(pool),
    f.identity.service.refreshContext,
    async () => {},
  );
  const context = await f.identity.service.resolveTenant(
    { cookie: owner.cookie },
    f.org.id,
    randomUUID(),
  );
  const approver = await f.identity.service.resolveTenant(
    { cookie: member.cookie },
    f.org.id,
    randomUUID(),
  );
  const action = {
    schemaVersion: 1,
    id: randomUUID(),
    tenantId: f.org.id,
    capability: 'inventory.write',
    capabilityVersion: '1',
    connectionId: randomUUID(),
    target: { kind: 'sku', id: 'sku-1' },
    parameters: {},
    expectedPostcondition: {},
    preconditions: {
      evidenceRefs: ['evidence'],
      validUntil: new Date(Date.now() + 600000).toISOString(),
    },
    risk: 'low',
    proposedBy: { kind: 'user', id: owner.id },
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  const capability = {
    available: true,
    minimumRisk: 'low',
    permission: 'actions.execute',
  };
  const evaluate = () =>
    policies.evaluate(context, action, 'a'.repeat(64), capability);
  expect((await evaluate()).outcome).toBe('allowed');
  await request(
    owner,
    `${base}/settings/approvals`,
    'PATCH',
    command({ revision: 0, alwaysRequireApproval: true }),
  );
  const review = await evaluate();
  expect(review.outcome).toBe('approval_required');
  await expect(
    policies.respond(context, review.id, 'approved', action.expiresAt),
  ).rejects.toThrow('different approver');
  await policies.respond(approver, review.id, 'approved', action.expiresAt);
  expect((await evaluate()).outcome).toBe('allowed');
  await request(
    owner,
    `${base}/settings/approvals`,
    'PATCH',
    command({ revision: 1, alwaysRequireApproval: false }),
  );
  await expect(
    policies.respond(approver, review.id, 'approved', action.expiresAt),
  ).rejects.toThrow('policy changed');
  expect((await evaluate()).policyVersion).not.toBe(review.policyVersion);
  expect(
    (
      await policies.evaluate(
        context,
        { ...action, id: randomUUID(), risk: 'high' },
        'b'.repeat(64),
        capability,
      )
    ).outcome,
  ).toBe('approval_required');
  expect(
    (
      await policies.evaluate(context, action, 'a'.repeat(64), {
        ...capability,
        available: false,
      })
    ).outcome,
  ).toBe('denied');
});

it('replays membership commands without overwriting later role changes', async (t) => {
  const f = await settingsFixture(t);
  const commandId = randomUUID();
  const change = (id, role) =>
    f.app.inject({
      method: 'PATCH',
      url: `${f.base}/members/${f.membership.id}`,
      headers: {
        origin: 'http://localhost:3000',
        cookie: f.owner.cookie,
        'x-command-id': id,
      },
      payload: { roleId: role },
    });
  expect((await change(commandId, 'admin')).statusCode).toBe(200);
  expect((await change(randomUUID(), 'owner')).statusCode).toBe(200);
  expect((await change(commandId, 'admin')).statusCode).toBe(200);
  expect(
    (await f.request(f.owner, `${f.base}/members`)).items.find(
      (m) => m.id === f.membership.id,
    ).role.id,
  ).toBe('owner');
  expect((await change(commandId, 'member')).statusCode).toBe(409);
});

it('keeps workspace reads and opt-out available while a provider call is pending', async (t) => {
  const f = await settingsFixture(t);
  let release;
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.setBeforeSend(async () => {
    entered();
    await gate;
  });
  await f.request(
    f.owner,
    `${f.base}/settings/notifications/test`,
    'POST',
    f.command({}),
  );
  const draining = f.drain();
  try {
    await started;
    await f.request(f.owner, `${f.base}/settings`);
    await f.request(
      f.owner,
      `${f.base}/settings/notifications`,
      'PATCH',
      f.command({ revision: 0, issues: false, connections: false }),
    );
  } finally {
    release();
    await draining;
  }
  expect(f.messages.size).toBe(1);
});

it('keeps Home layouts and pins personal, versioned and tenant scoped', async (t) => {
  const { request, owner, member, outsider, base } = await settingsFixture(t);
  expect(await request(owner, `${base}/settings/layout`)).toEqual({
    home: null,
    pinned: [],
    revision: 0,
  });
  const layout = {
    revision: 0,
    home: [
      { id: 'outcomes', size: 'full' },
      { id: 'attention', size: 'half' },
    ],
    pinned: [{ path: 'exceptions?view=active', label: 'Open issues' }],
  };
  const saved = await request(owner, `${base}/settings/layout`, 'PUT', layout);
  expect(saved).toEqual({ ...layout, revision: 1 });
  expect(await request(owner, `${base}/settings/layout`)).toEqual(saved);
  expect(await request(member, `${base}/settings/layout`)).toEqual({
    home: null,
    pinned: [],
    revision: 0,
  });
  await request(owner, `${base}/settings/layout`, 'PUT', layout, 409);
  await request(
    owner,
    `${base}/settings/layout`,
    'PUT',
    {
      ...layout,
      revision: 1,
      home: [
        { id: 'attention', size: 'full' },
        { id: 'attention', size: 'half' },
      ],
    },
    400,
  );
  await request(
    owner,
    `${base}/settings/layout`,
    'PUT',
    { ...layout, revision: 1, pinned: [{ path: '../admin', label: 'Escape' }] },
    400,
  );
  await request(outsider, `${base}/settings/layout`, 'GET', undefined, 404);
  expect(
    await request(owner, `${base}/settings/layout`, 'PUT', {
      revision: 1,
      home: null,
      pinned: [],
    }),
  ).toEqual({ home: null, pinned: [], revision: 2 });
});

it('defaults new workspaces to observe-only and audits owner mode commands without accepting stale or foreign writes', async (t) => {
  const f = await settingsFixture(t);
  const { request, owner, member, outsider, base, command } = f;
  expect((await request(owner, `${base}/settings`)).workspace.writeMode).toBe(
    'observe_only',
  );
  const enable = command({ revision: 0, writeMode: 'writes_enabled' });
  await request(member, `${base}/settings/write-mode`, 'PATCH', enable, 403);
  await request(outsider, `${base}/settings/write-mode`, 'PATCH', enable, 404);
  const enabled = await request(
    owner,
    `${base}/settings/write-mode`,
    'PATCH',
    enable,
  );
  expect(enabled.workspace).toMatchObject({
    writeMode: 'writes_enabled',
    revision: 1,
  });
  expect(
    await request(owner, `${base}/settings/write-mode`, 'PATCH', enable),
  ).toEqual(enabled);
  await request(
    owner,
    `${base}/settings/write-mode`,
    'PATCH',
    command({ revision: 0, writeMode: 'observe_only' }),
    409,
  );
  await request(
    owner,
    `${base}/settings/write-mode`,
    'PATCH',
    command({ revision: 1, writeMode: 'observe_only' }),
  );
  const events = await f.db.owner.query(
    "SELECT before_value,after_value FROM workspace_access_events WHERE tenant_id=$1 AND event_type='workspace.write_mode_changed' ORDER BY created_at",
    [f.org.id],
  );
  expect(events.rows).toEqual([
    {
      before_value: { writeMode: 'observe_only' },
      after_value: { writeMode: 'writes_enabled' },
    },
    {
      before_value: { writeMode: 'writes_enabled' },
      after_value: { writeMode: 'observe_only' },
    },
  ]);
});

it('lets solo owners approve, preserves team preferences and invalidates reviews when the effective rule changes', async (t) => {
  const f = await settingsFixture(t);
  const { request, owner, member, outsider, base, command } = f;
  const pool = new Pool({ connectionString: f.db.runtimeUrl });
  t.onTestFinished(() => pool.end());
  const policies = createPolicies(
    createTenantDatabase(pool),
    f.identity.service.refreshContext,
    async () => {},
  );
  const context = await f.identity.service.resolveTenant(
    { cookie: owner.cookie },
    f.org.id,
    randomUUID(),
  );
  const memberContext = await f.identity.service.resolveTenant(
    { cookie: member.cookie },
    f.org.id,
    randomUUID(),
  );
  const expiresAt = new Date(Date.now() + 600000).toISOString();
  const action = {
    schemaVersion: 1,
    id: randomUUID(),
    tenantId: f.org.id,
    capability: 'inventory.write',
    capabilityVersion: '1',
    connectionId: randomUUID(),
    target: { kind: 'sku', id: 'sku-1' },
    parameters: {},
    expectedPostcondition: {},
    preconditions: { evidenceRefs: ['evidence'], validUntil: expiresAt },
    risk: 'high',
    proposedBy: { kind: 'user', id: owner.id },
    expiresAt,
  };
  const evaluate = () =>
    policies.evaluate(context, action, 'c'.repeat(64), {
      available: true,
      minimumRisk: 'high',
      permission: 'actions.execute',
    });
  expect((await request(owner, `${base}/settings`)).workspace).toMatchObject({
    activeMemberCount: 2,
    requireIndependentApproval: true,
  });
  const independentReview = await evaluate();
  await expect(
    policies.respond(context, independentReview.id, 'approved', expiresAt),
  ).rejects.toMatchObject({ statusCode: 403 });
  const change = command({
    revision: 0,
    alwaysRequireApproval: false,
    requireIndependentApproval: false,
  });
  await request(member, `${base}/settings/approvals`, 'PATCH', change, 403);
  await request(outsider, `${base}/settings/approvals`, 'PATCH', change, 404);
  const saved = await request(
    owner,
    `${base}/settings/approvals`,
    'PATCH',
    change,
  );
  expect(
    await request(owner, `${base}/settings/approvals`, 'PATCH', change),
  ).toEqual(saved);
  await request(
    owner,
    `${base}/settings/approvals`,
    'PATCH',
    command({ ...change, revision: 0, requireIndependentApproval: true }),
    409,
  );
  await expect(
    policies.respond(context, independentReview.id, 'approved', expiresAt),
  ).rejects.toMatchObject({ statusCode: 409 });
  const selfReview = await evaluate();
  expect(selfReview.outcome).toBe('approval_required');
  await expect(
    policies.respond(memberContext, selfReview.id, 'approved', expiresAt),
  ).rejects.toMatchObject({ statusCode: 403 });
  const selfApproval = await policies.respond(
    context,
    selfReview.id,
    'approved',
    expiresAt,
  );
  expect(selfApproval.approverId).toBe(selfApproval.requesterId);
  expect((await evaluate()).outcome).toBe('allowed');
  const events = await f.db.owner.query(
    "SELECT before_value,after_value FROM workspace_access_events WHERE tenant_id=$1 AND event_type='policy.updated'",
    [f.org.id],
  );
  expect(events.rows).toEqual([
    {
      before_value: {
        required: false,
        requireIndependentApproval: true,
        replenishmentApproval: { separateSend: false, threshold: null },
        version: 0,
      },
      after_value: {
        required: false,
        requireIndependentApproval: false,
        replenishmentApproval: { separateSend: false, threshold: null },
        version: 1,
      },
    },
  ]);
  await request(
    owner,
    `${base}/settings/approvals`,
    'PATCH',
    command({
      revision: 1,
      alwaysRequireApproval: false,
      requireIndependentApproval: true,
    }),
  );
  expect((await evaluate()).outcome).toBe('approval_required');
  await request(
    owner,
    `${base}/members/${f.membership.id}`,
    'DELETE',
    undefined,
    204,
  );
  expect((await request(owner, `${base}/settings`)).workspace).toMatchObject({
    activeMemberCount: 1,
    requireIndependentApproval: true,
  });
  expect(await policies.requiresIndependentApproval(f.org.id)).toBe(false);
  const soloReview = await evaluate();
  await policies.respond(context, soloReview.id, 'approved', expiresAt);
  expect((await evaluate()).outcome).toBe('allowed');
  // An invitation does not count as a person who can enter and approve.
  await request(
    owner,
    `${base}/settings/invitations`,
    'POST',
    command({ email: outsider.email, roleId: 'admin' }),
  );
  expect(await policies.requiresIndependentApproval(f.org.id)).toBe(false);
  await request(
    owner,
    `${base}/members`,
    'POST',
    { userId: member.id, roleId: 'admin' },
    201,
  );
  expect(await policies.requiresIndependentApproval(f.org.id)).toBe(true);
  expect((await evaluate()).outcome).toBe('approval_required');
  await expect(
    policies.respond(context, soloReview.id, 'approved', expiresAt),
  ).rejects.toMatchObject({ statusCode: 409 });
  // Suspended and disabled people cannot supply the second approval.
  await f.db.owner.query(
    "UPDATE memberships SET status='suspended',suspended_at=now(),suspended_by_kind='customer',suspended_by=$2 WHERE tenant_id=$1 AND user_id=$3",
    [f.org.id, owner.id, member.id],
  );
  expect(await policies.requiresIndependentApproval(f.org.id)).toBe(false);
  await f.db.owner.query(
    "UPDATE memberships SET status='active',suspended_at=NULL,suspended_by_kind=NULL,suspended_by=NULL WHERE tenant_id=$1 AND user_id=$2",
    [f.org.id, member.id],
  );
  await f.db.owner.query(
    "INSERT INTO account_disablements(user_id,disabled_by,reason_category,reason) VALUES($1,$2,'other','Fixture account unavailable')",
    [member.id, randomUUID()],
  );
  expect(await policies.requiresIndependentApproval(f.org.id)).toBe(false);
  expect(
    (await request(owner, `${base}/settings`)).workspace.activeMemberCount,
  ).toBe(1);
  // Exact rejection remains binding when policy changes, including the solo exception.
  const rejectedAction = { ...action, id: randomUUID() };
  const rejectedReview = await policies.evaluate(
    context,
    rejectedAction,
    'd'.repeat(64),
    { available: true, minimumRisk: 'high', permission: 'actions.execute' },
  );
  await policies.respond(context, rejectedReview.id, 'rejected', expiresAt);
  await f.db.owner.query('DELETE FROM account_disablements WHERE user_id=$1', [
    member.id,
  ]);
  expect(
    (
      await policies.evaluate(context, rejectedAction, 'd'.repeat(64), {
        available: true,
        minimumRisk: 'high',
        permission: 'actions.execute',
      })
    ).reason,
  ).toBe('approval_rejected');
});
