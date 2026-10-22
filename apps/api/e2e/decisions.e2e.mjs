import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { expect, it } from 'vitest';

import {
  respond,
  startJourney,
  waitFor,
} from '../../../tooling/pilot/journey.mjs';
import { createPilot } from '../../../tooling/pilot/runtime.mjs';
import { seedPilot } from '../../../tooling/pilot/seed.mjs';
import { database, secret } from './helpers.mjs';
import { replenishmentFixture } from './replenishment-fixture.mjs';

it('lists replenishment approvals in Needs you and follows decisions made on the workflow run', async (t) => {
  const f = await replenishmentFixture(t, undefined, { imported: true });
  const organization = `/v1/organizations/${f.manifest.organizationId}`;
  const queue = async (
    query = '',
    { cookie = f.ownerCookie, status = 200 } = {},
  ) => {
    const response = await f.pilot.app.inject({
      method: 'GET',
      url: `${organization}/decisions${query}`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(status);

    return response.json();
  };
  const assign = async (
    body,
    { cookie = f.ownerCookie, status = 200 } = {},
  ) => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: `${organization}/decisions/assignments`,
      headers: { cookie, origin: 'http://127.0.0.1:3000' },
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(status);

    return response.json();
  };

  const rule = await f.configure();
  const run = await f.request('/replenishment/starts', {
    id: randomUUID(),
    activationId: rule.id,
  });
  await f.waitFor(run.id, 'awaiting_decision');
  const id = `replenishment:${run.id}`;

  // The principal who started the run sees it but needs a different approver.
  const actionable = await queue();
  expect(actionable.items.map((item) => item.id)).not.toContain(id);
  expect(
    actionable.items.every((item) =>
      ['decide', 'run', 'check', 'investigate'].includes(item.response),
    ),
  ).toBe(true);
  const own = await queue('?scope=waiting');
  expect(own.sources).toEqual(
    expect.arrayContaining([
      { id: 'cases', label: 'Issues', state: 'available' },
      { id: 'replenishment', label: 'Replenishment', state: 'available' },
    ]),
  );
  const requested = own.items.find((item) => item.id === id);
  expect(requested).toMatchObject({
    kind: 'replenishment',
    reason: 'approval',
    domain: 'procurement',
    response: 'awaiting_other',
    urgency: 'normal',
    impact: { level: 'unknown' },
    requesterId: f.actor.actor.id,
    record: { kind: 'position', id: f.position.positionId },
    owner: {
      kind: 'workflow_run',
      definitionId: 'inventory-replenishment',
      runId: run.id,
    },
    evidence: { state: 'fresh' },
    assignment: null,
  });
  expect(requested.title).toContain('purchase-order draft');
  expect(requested.consequences.map((c) => c.response)).toEqual([
    'Approve',
    'Reject',
  ]);
  expect(requested.change).toEqual(
    expect.arrayContaining([{ label: 'Quantity', value: expect.any(String) }]),
  );
  expect(Date.parse(requested.deadline)).toBeGreaterThan(Date.now());
  expect(own.counts.domains.procurement).toBeGreaterThanOrEqual(1);
  expect(own.counts.reasons.approval).toBeGreaterThanOrEqual(1);

  // A different admin can decide it; filters and counts agree.
  const other = await queue('?domain=procurement&reason=approval', {
    cookie: f.approverCookie,
  });
  expect(other.items.map((item) => item.id)).toContain(id);
  expect(other.items.find((item) => item.id === id).response).toBe('decide');
  expect(other.totalCount).toBe(other.items.length);
  expect(
    (await queue('?domain=fulfillment')).items.map((i) => i.id),
  ).not.toContain(id);

  // Assignment uses optimistic revisions and feeds the views.
  const taken = await assign({
    decisionId: id,
    assigneeId: f.actor.actor.id,
    revision: 0,
  });
  expect(taken.assignment).toMatchObject({
    assigneeId: f.actor.actor.id,
    revision: 1,
  });
  await assign(
    { decisionId: id, assigneeId: null, revision: 0 },
    { status: 409 },
  );
  const mine = await queue('?view=mine&scope=waiting');
  expect(mine.items.map((item) => item.id)).toContain(id);
  expect(mine.items.find((item) => item.id === id).assignment.revision).toBe(1);
  expect(mine.counts.views.mine).toBeGreaterThanOrEqual(1);
  expect(
    (await queue('?view=unassigned&scope=waiting')).items.map((i) => i.id),
  ).not.toContain(id);
  await assign(
    {
      decisionId: 'replenishment:00000000-0000-4000-8000-000000000000',
      assigneeId: null,
      revision: 0,
    },
    { status: 404 },
  );
  await assign(
    { decisionId: id, assigneeId: randomUUID(), revision: 1 },
    { status: 409 },
  );

  // Pages keep their filters; a cursor from other filters is rejected.
  const first = await queue('?limit=1&scope=waiting');
  if (first.nextCursor) {
    const second = await queue(
      `?limit=1&scope=waiting&cursor=${first.nextCursor}`,
    );
    expect(second.offset).toBe(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    await queue(`?limit=1&view=mine&cursor=${first.nextCursor}`, {
      status: 400,
    });
  }

  // Another workspace can't read this queue.
  const foreign = await f.pilot.app.inject({
    method: 'GET',
    url: `/v1/organizations/${randomUUID()}/decisions`,
    headers: { cookie: f.ownerCookie },
  });
  expect([403, 404]).toContain(foreign.statusCode);

  // Deciding on the workflow run removes the item everywhere; a stale second decision fails.
  const review = await f.request(`/replenishment/runs/${run.id}`, undefined, {
    cookie: f.approverCookie,
  });
  await f.decide(run);
  await f.request(
    `/replenishment/runs/${run.id}/decision`,
    { decisionId: review.decisionId, outcome: 'approved' },
    { cookie: f.approverCookie, status: 409 },
  );
  expect((await queue()).items.map((item) => item.id)).not.toContain(id);
  await assign(
    { decisionId: id, assigneeId: null, revision: 1 },
    { status: 404 },
  );
  await f.waitFor(run.id, 'verified');
  const archived = await f.pilot.app.inject({
    url: `${organization}/decisions/${encodeURIComponent(id)}`,
    headers: { cookie: f.approverCookie },
  });
  expect(archived.statusCode, archived.body).toBe(200);
  expect(archived.json()).toMatchObject({
    response: 'view_only',
    assignment: null,
    outcome: {
      state: 'approved',
      next: 'verified',
      actorEmail: 'pilot-requester@example.test',
    },
  });
  const inaccessible = await f.pilot.app.inject({
    url: `/v1/organizations/${randomUUID()}/decisions/${encodeURIComponent(id)}`,
    headers: { cookie: f.ownerCookie },
  });
  expect([403, 404]).toContain(inaccessible.statusCode);
});

it('projects a case approval for each reader and drops it once the case desk decides', async (t) => {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  await db.owner.query(
    `GRANT luma_exceptions,luma_connectors TO "${new URL(db.runtimeUrl).username}"`,
  );
  const directory = await mkdtemp(join(tmpdir(), 'luma-decisions-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const temporal = await TestWorkflowEnvironment.createLocal();
  t.onTestFinished(() => temporal.teardown());
  const env = {
    IDENTITY_DATABASE_URL: db.runtimeUrl,
    WORKFLOW_DATABASE_URL: db.runtimeUrl,
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: 'http://127.0.0.1:3000',
    AUTH_RATE_LIMIT: 'off',
    CONNECTIONS_ACTIVE_KEY_ID: 'test',
    CONNECTIONS_KEYS: JSON.stringify({
      test: randomBytes(32).toString('base64'),
    }),
  };
  const password = randomUUID();
  const manifest = await seedPilot(
    { seedPassword: password },
    env,
    directory,
    'approval-required',
  );
  const pilot = await createPilot(env, directory, manifest, {
    address: temporal.address,
    namespace: 'default',
    taskQueue: `decisions-${manifest.runId}`,
    dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
  });
  const client = await pilot.runtime.createClient();
  const worker = await pilot.runtime.createWorker();
  const running = worker.run();
  t.onTestFinished(async () => {
    worker.shutdown();
    await running;
    await worker.close();
    await client.close();
    await pilot.close();
  });
  await startJourney(pilot, manifest, client);
  const source = { kind: 'incident', id: manifest.incidents.workflow_failure };
  const approver = await pilot.operator();
  await waitFor(
    async () =>
      (await client.progress(approver, source))?.phase === 'awaiting_approval',
  );
  const id = `case:${source.id}`;
  const find = async (actor) =>
    (await pilot.decisions.list(actor, { view: 'all', limit: 100 })).items.find(
      (item) => item.id === id,
    );

  const review = await pilot.desk.review(approver, source.id);
  expect(review.permittedDecisions).toContain('approve');
  const item = await find(approver);
  expect(item).toMatchObject({
    kind: 'case',
    reason: 'approval',
    response: 'decide',
    requesterId: review.proposal.requestedBy,
    owner: { kind: 'case', exceptionId: source.id },
  });
  expect(item.consequences.map((c) => c.response)).toEqual([
    'Approve',
    'Reject',
    'Escalate',
  ]);
  expect(Date.parse(item.deadline)).toBeLessThanOrEqual(
    Date.parse(review.proposal.expiresAt),
  );

  const signedIn = await pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { email: 'pilot-operator@example.test', password },
  });
  expect(signedIn.statusCode, signedIn.body).toBe(200);
  const cookie = []
    .concat(signedIn.headers['set-cookie'])
    .map((value) => value.split(';')[0])
    .join('; ');
  const assignmentUrl = `/v1/organizations/${manifest.organizationId}/decisions/assignments`;
  const take = await pilot.app.inject({
    method: 'POST',
    url: assignmentUrl,
    headers: { cookie, origin: 'http://127.0.0.1:3000' },
    payload: { decisionId: id, assigneeId: approver.actor.id, revision: 0 },
  });
  expect(take.statusCode, take.body).toBe(200);
  const assigned = await find(approver);
  expect(assigned.assignment).toMatchObject({
    assigneeId: approver.actor.id,
    revision: 1,
  });
  expect(
    (await pilot.detection.cases.get(approver, source.id)).owner.userId,
  ).toBe(approver.actor.id);
  const release = await pilot.app.inject({
    method: 'POST',
    url: assignmentUrl,
    headers: { cookie, origin: 'http://127.0.0.1:3000' },
    payload: { decisionId: id, assigneeId: null, revision: 1 },
  });
  expect(release.statusCode, release.body).toBe(200);
  expect((await find(approver)).assignment).toMatchObject({
    assigneeId: null,
    revision: 2,
  });
  const staleAssignment = await pilot.app.inject({
    method: 'POST',
    url: assignmentUrl,
    headers: { cookie, origin: 'http://127.0.0.1:3000' },
    payload: { decisionId: id, assigneeId: approver.actor.id, revision: 1 },
  });
  expect(staleAssignment.statusCode, staleAssignment.body).toBe(409);

  await respond(pilot, manifest, client, 'approve');
  // The approval leaves the queue at once. The case may stay for other inbox attention rules,
  // such as its rule-produced manual step, but never asks for the approval again.
  const after = await find(approver);
  expect(after?.reason).not.toBe('approval');
  expect(after?.response).not.toBe('decide');
  await expect(
    pilot.desk.decide(approver, source.id, {
      commandId: randomUUID(),
      kind: 'approve',
      caseRevision: review.caseRevision,
      diagnosisRevision: review.diagnosisRevision,
      proposalId: review.proposal.id,
      proposalVersion: review.proposal.version,
      decisionId: review.proposal.policy.id,
      reason: 'Approving again from a stale review',
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});
