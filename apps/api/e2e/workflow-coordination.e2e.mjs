import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createDetectionServices } from '@luma/application-runtime';
import { createAuditLog } from '@luma/audit/composition';
import { defaultConfiguration } from '@luma/exceptions';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import {
  createProcessWorker,
  processWorkflowId,
} from '@luma/workflow-temporal';
import {
  compileProcessWorkflow,
  createCoordination,
  createProcessStepStore,
  createWorkflows,
  createWorkflowTriggerStore,
} from '@luma/workflows/composition';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { database, signup, startApi } from './helpers.mjs';

it('persists supplier acknowledgment and human handoffs across a durable worker restart, with isolated answers and subscription provenance', async (t) => {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  await db.owner.query(
    `GRANT luma_identity,luma_desk,luma_exceptions TO "${new URL(db.runtimeUrl).username}"`,
  );
  const api = await startApi(t, db);
  const user = await signup(api, 'coordination-owner');
  const other = await signup(api, 'coordination-other');
  const org = (
    await api.request('/v1/organizations', {
      cookie: user.cookie,
      method: 'POST',
      status: 201,
      body: { name: 'Coordination', slug: 'coordination', dataRegion: 'EU' },
    })
  ).body;
  await db.owner.query(
    'INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,$4,now())',
    [randomUUID(), org.id, other.userId, 'member'],
  );
  const membership = (
    await db.owner.query(
      'SELECT id FROM memberships WHERE tenant_id=$1 AND user_id=$2',
      [org.id, user.userId],
    )
  ).rows[0];
  const context = makeTenantContext(
    { userId: user.userId, sessionId: 'fixture' },
    { ...org, status: 'active' },
    builtInMembership(
      { id: membership.id, organizationId: org.id, userId: user.userId },
      'owner',
    ),
    'coordination-fixture',
  );
  const pool = new Pool({ connectionString: db.runtimeUrl });
  t.onTestFinished(() => pool.end());
  const tenantDb = createTenantDatabase(pool);
  const identity = {
    refreshContext: async (value) => value,
    resolveWorkflowContext: async () => context,
    listMembers: async () => [
      { userId: user.userId, role: { id: 'owner' } },
      { userId: other.userId, role: { id: 'member' } },
    ],
  };
  const coordination = createCoordination(tenantDb, identity, createAuditLog);
  const detection = createDetectionServices(db.runtimeUrl);
  t.onTestFinished(() => detection.close());
  const corpus = JSON.parse(
    await readFile(
      new URL(
        '../../../packages/exceptions/fixtures/exceptions-v0.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const connectionId = randomUUID();
  const detected = await detection.exceptions.ingest(context, {
    key: 'coordination-case',
    input: {
      exceptionClass: 'sync_failure',
      facts: {
        ...corpus.bases.sync_failure,
        tenantId: org.id,
        evidenceTenantId: org.id,
        connectionId,
        subjectId: connectionId,
        evidenceRefs: ['coordination-case'],
      },
    },
    configuration: defaultConfiguration,
    evidence: [
      {
        key: 'coordination-case',
        tenantId: org.id,
        connectionId,
        observedAt: new Date().toISOString(),
        sourceUpdatedAt: null,
        adapterVersion: 'fixture-v1',
        schemaVersion: 1,
        source: {
          provider: 'Shopify',
          resource: 'Orders',
          externalId: 'scan',
          scopeKey: 'orders',
        },
        facts: { errorCode: 'authentication' },
      },
    ],
  });
  const caseId = detected.incident.id;
  const caseRoot = `/v1/organizations/${org.id}/exceptions/${caseId}`;
  const assigned = (
    await api.request(`${caseRoot}/owner`, {
      cookie: user.cookie,
      method: 'POST',
      body: { userId: user.userId, revision: 0 },
    })
  ).body;
  expect(assigned).toMatchObject({ userId: user.userId, revision: 1 });
  await api.request(`${caseRoot}/owner`, {
    cookie: user.cookie,
    method: 'POST',
    status: 409,
    body: { userId: null, revision: 0 },
  });
  await api.request(`${caseRoot}/owner`, {
    cookie: other.cookie,
    method: 'POST',
    status: 403,
    body: { userId: other.userId, revision: 1 },
  });
  expect(
    (
      await api.request(
        `/v1/organizations/${org.id}/exceptions?view=active&ownerId=${user.userId}`,
        { cookie: user.cookie },
      )
    ).body.items.map((item) => item.id),
  ).toContain(caseId);

  const catalog = createWorkflows(tenantDb, {}, identity.refreshContext, {
    approvalRequirement: async () => ({
      mode: 'every_action',
      reason: 'minimum_risk',
    }),
  });
  const source = {
    schemaVersion: 2,
    definition: {
      id: 'supplier-acknowledgment',
      name: 'Supplier acknowledgment',
      intent: 'Wait for supplier evidence, then ask the operator to review it.',
      category: 'procurement',
    },
    version: '1.0.0',
    applicability: {
      trigger: { kind: 'manual' },
      subjectKind: 'purchase_order',
    },
    inputs: { purchaseOrderId: 'string', caseId: 'string' },
    context: {
      kind: 'procurement.purchase-order',
      fields: { submitted: 'boolean' },
      maxAgeSeconds: 300,
    },
    steps: [
      {
        id: 'acknowledgment',
        kind: 'event_wait',
        eventType: 'supplier.acknowledged',
        correlation: { source: 'input', field: 'purchaseOrderId' },
        fields: { acknowledged: 'boolean' },
        timeoutSeconds: 60,
        onTimeout: 'escalate',
      },
      {
        id: 'review',
        kind: 'human_task',
        assignee: { kind: 'person', id: user.userId },
        instructions: 'Review the supplier acknowledgment.',
        choices: ['Confirmed', 'Needs investigation'],
        evidence: 'text',
        dueAfterSeconds: 1,
        escalationTarget: { kind: 'role', key: 'admin' },
      },
      { id: 'end', kind: 'end', outcome: 'Acknowledgment reviewed' },
    ],
    provenance: {
      kind: 'native',
      reference: 'supplier-acknowledgment',
      authoredBy: user.userId,
      evidenceRefs: ['supplier-observation'],
    },
  };
  // A fallback role needs a current member. The initiator can still answer before escalation.
  source.steps[1].escalationTarget = { kind: 'role', key: 'owner' };
  const version = compileProcessWorkflow(source);
  await catalog.publish(context, version);
  const root = `/v1/organizations/${org.id}/workflows/${version.definition.id}`;
  const subscription = (
    await api.request(`${root}/subscriptions`, {
      cookie: user.cookie,
      method: 'POST',
      body: {
        id: randomUUID(),
        revision: 0,
        version: version.version,
        reviewedDigest: version.digest,
        trigger: { kind: 'manual' },
        active: true,
      },
    })
  ).body;
  const orderId = randomUUID();
  const occurredAt = new Date().toISOString();
  const started = (
    await api.request(`${root}/starts`, {
      cookie: user.cookie,
      method: 'POST',
      body: {
        subscription: { id: subscription.id, revision: subscription.revision },
        version: version.version,
        reviewedDigest: version.digest,
        subject: { kind: 'purchase_order', id: orderId },
        signal: { kind: 'manual', sourceId: randomUUID(), occurredAt },
        context: {
          inputs: { purchaseOrderId: orderId, caseId },
          evidence: {
            kind: 'procurement.purchase-order',
            facts: { submitted: true },
            observations: [
              { id: randomUUID(), observedAt: occurredAt, source: 'supplier' },
            ],
          },
          provenance: { reference: 'supplier-order', capturedAt: occurredAt },
        },
      },
    })
  ).body;
  const run = await createWorkflowTriggerStore(tenantDb).run(
    context,
    started.id,
  );
  expect(run.subscription).toMatchObject({
    id: subscription.id,
    revision: 1,
    trigger: { kind: 'manual' },
  });
  const event = {
    sourceId: randomUUID(),
    eventType: 'supplier.acknowledged',
    correlationKey: orderId,
    occurredAt: new Date().toISOString(),
    values: { acknowledged: true },
    evidenceRefs: ['supplier-observation'],
  };
  await api.request(`${root}/events`, {
    cookie: user.cookie,
    method: 'POST',
    body: event,
  });
  await api.request(`${root}/events`, {
    cookie: user.cookie,
    method: 'POST',
    body: event,
  });
  await api.request(`${root}/events`, {
    cookie: user.cookie,
    method: 'POST',
    status: 409,
    body: { ...event, values: { acknowledged: false } },
  });
  const second = (
    await api.request(`${root}/subscriptions`, {
      cookie: user.cookie,
      method: 'POST',
      body: {
        id: subscription.id,
        revision: 1,
        version: version.version,
        reviewedDigest: version.digest,
        trigger: {
          kind: 'schedule',
          at: new Date(Date.now() + 3600000).toISOString(),
        },
        active: true,
      },
    })
  ).body;
  expect(second.revision).toBe(2);
  expect(
    (await createWorkflowTriggerStore(tenantDb).run(context, run.id))
      .subscription.revision,
  ).toBe(1);
  expect(
    (
      await createWorkflowTriggerStore(tenantDb).version(
        context,
        version.definition.id,
        version.version,
      )
    ).digest,
  ).toBe(version.digest);
  const env = await TestWorkflowEnvironment.createLocal();
  t.onTestFinished(() => env.teardown());
  const settings = {
    address: env.address,
    namespace: 'default',
    dataRegion: 'EU',
    taskQueue: randomUUID(),
  };
  const unavailable = async () => {
    throw new Error('This scenario has no provider effect');
  };
  const steps = createProcessStepStore(tenantDb);
  const activities = {
    coordinate: coordination.coordinate,
    read: unavailable,
    decision: unavailable,
    action: unavailable,
    verify: unavailable,
    record: async (currentRun, output) =>
      steps.record(context, currentRun.id, output),
  };
  let worker = await createProcessWorker(settings, activities);
  let running = worker.run();
  const handle = await env.client.workflow.start('processWorkflow', {
    workflowId: processWorkflowId(org.id, run.id),
    taskQueue: settings.taskQueue,
    args: [run, version],
  });
  await expect
    .poll(async () => (await handle.query('processProgress')).state, {
      timeout: 20000,
    })
    .toBe('waiting');
  worker.shutdown();
  await running;
  await worker.close();
  worker = await createProcessWorker(settings, activities);
  running = worker.run();
  t.onTestFinished(async () => {
    worker.shutdown();
    await running;
    await worker.close();
  });
  const taskRoot = `${root}/runs/${run.id}/tasks/review`;
  await api.request(taskRoot, { cookie: other.cookie, status: 404 });
  await expect
    .poll(
      async () =>
        (await api.request(taskRoot, { cookie: user.cookie })).body.escalatedAt,
      { timeout: 10000 },
    )
    .not.toBeNull();
  const answer = {
    choice: 'Confirmed',
    note: 'Supplier quantities checked.',
    evidence: {
      kind: 'text',
      value: 'Acknowledgment in supplier observation.',
    },
  };
  await api.request(`${taskRoot}/answer`, {
    cookie: user.cookie,
    method: 'POST',
    status: 422,
    body: { ...answer, choice: 'Not a choice' },
  });
  await api.request(`${taskRoot}/answer`, {
    cookie: user.cookie,
    method: 'POST',
    body: answer,
  });
  await api.request(`${taskRoot}/answer`, {
    cookie: user.cookie,
    method: 'POST',
    body: answer,
  });
  await api.request(`${taskRoot}/answer`, {
    cookie: user.cookie,
    method: 'POST',
    status: 409,
    body: { ...answer, choice: 'Needs investigation' },
  });
  await handle.signal('processDecisionChanged').catch((error) => {
    if (error.name !== 'WorkflowNotFoundError') throw error;
  });
  expect(await handle.result()).toMatchObject({
    state: 'ended',
    stepId: 'end',
  });
  const receipts = (await steps.list(context, [run.id])).get(run.id);
  expect(
    receipts.filter(
      (item) => item.stepId === 'review' && item.state === 'completed',
    ),
  ).toHaveLength(1);
  expect(
    receipts.find(
      (item) => item.stepId === 'review' && item.state === 'completed',
    ).values,
  ).toMatchObject({ actorId: user.userId, choice: 'Confirmed' });
  const timeline = (
    await api.request(`${caseRoot}/timeline`, { cookie: user.cookie })
  ).body;
  expect(timeline.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'case.owner_changed' }),
      expect.objectContaining({
        type: 'workflow.human_task_answered',
        reason: expect.stringContaining('Supplier quantities checked.'),
      }),
    ]),
  );
  const cleared = (
    await api.request(`${caseRoot}/owner`, {
      cookie: user.cookie,
      method: 'POST',
      body: { userId: null, revision: 1 },
    })
  ).body;
  expect(cleared).toMatchObject({ userId: null, revision: 2 });
  // A later run retains its own deadline. Receipt after timeout cannot revive it.
  const timeoutVersion = compileProcessWorkflow({
    ...source,
    version: '2.0.0',
    steps: [
      { ...source.steps[0], timeoutSeconds: 1 },
      ...source.steps.slice(1),
    ],
  });
  await catalog.publish(context, timeoutVersion);
  const freshStart = async (targetVersion) => {
    const at = new Date().toISOString();
    const result = (
      await api.request(`${root}/starts`, {
        cookie: user.cookie,
        method: 'POST',
        body: {
          version: targetVersion.version,
          reviewedDigest: targetVersion.digest,
          subject: { kind: 'purchase_order', id: randomUUID() },
          signal: { kind: 'manual', sourceId: randomUUID(), occurredAt: at },
          context: {
            inputs: { purchaseOrderId: randomUUID(), caseId },
            evidence: {
              kind: targetVersion.context.kind,
              facts: { submitted: true },
              observations: [
                {
                  id: randomUUID(),
                  observedAt: at,
                  source: 'purchasing-system',
                },
              ],
            },
            provenance: { reference: 'supplier-observation', capturedAt: at },
          },
        },
      })
    ).body;

    return createWorkflowTriggerStore(tenantDb).run(context, result.id);
  };
  const timedRun = await freshStart(timeoutVersion);
  const timedHandle = await env.client.workflow.start('processWorkflow', {
    workflowId: processWorkflowId(org.id, timedRun.id),
    taskQueue: settings.taskQueue,
    args: [timedRun, timeoutVersion],
  });
  expect(await timedHandle.result()).toMatchObject({
    state: 'escalated',
    stepId: 'acknowledgment',
    reason: 'event_wait_timeout',
  });
  await api.request(`${root}/events`, {
    cookie: user.cookie,
    method: 'POST',
    body: {
      sourceId: randomUUID(),
      eventType: 'supplier.acknowledged',
      correlationKey: timedRun.context.inputs.purchaseOrderId,
      occurredAt: timedRun.createdAt,
      values: { acknowledged: true },
      evidenceRefs: ['late-acknowledgment'],
    },
  });
  expect(
    (await steps.list(context, [timedRun.id]))
      .get(timedRun.id)
      .map((item) => item.state),
  ).toEqual(['waiting', 'escalated']);
  // Cancellation is serialized with task answers and removes the open handoff.
  const taskVersion = compileProcessWorkflow({
    ...source,
    version: '3.0.0',
    steps: source.steps.slice(1),
  });
  await catalog.publish(context, taskVersion);
  const cancelledRun = await freshStart(taskVersion);
  await coordination.coordinate(
    cancelledRun,
    taskVersion.steps[0],
    [],
    cancelledRun.createdAt,
  );
  await steps.record(context, cancelledRun.id, {
    stepId: 'review',
    kind: 'human_task',
    state: 'waiting',
    values: {},
    evidenceRefs: ['cancelled-task'],
    recordedAt: cancelledRun.createdAt,
  });
  await api.request(`${root}/starts/${cancelledRun.id}/cancel`, {
    cookie: user.cookie,
    method: 'POST',
    body: {},
  });
  expect(
    await coordination.coordinate(
      cancelledRun,
      taskVersion.steps[0],
      [],
      cancelledRun.createdAt,
    ),
  ).toMatchObject({ state: 'cancelled' });
  await api.request(`${root}/runs/${cancelledRun.id}/tasks/review/answer`, {
    cookie: user.cookie,
    method: 'POST',
    status: 404,
    body: answer,
  });
  // Losing workspace access revokes answer authority without losing the handoff.
  const accessVersion = compileProcessWorkflow({
    ...source,
    version: '4.0.0',
    steps: [
      {
        ...source.steps[1],
        assignee: { kind: 'person', id: other.userId },
        dueAfterSeconds: 3,
      },
      ...source.steps.slice(2),
    ],
  });
  await catalog.publish(context, accessVersion);
  const accessRun = await freshStart(accessVersion);
  const accessHandle = await env.client.workflow.start('processWorkflow', {
    workflowId: processWorkflowId(org.id, accessRun.id),
    taskQueue: settings.taskQueue,
    args: [accessRun, accessVersion],
  });
  await expect
    .poll(async () => (await accessHandle.query('processProgress')).state, {
      timeout: 20000,
    })
    .toBe('waiting');
  expect(await coordination.pending(context)).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ runId: accessRun.id })]),
  );
  await db.owner.query(
    "UPDATE memberships SET status='suspended',suspended_at=now(),suspended_by_kind='customer',suspended_by=$3 WHERE tenant_id=$1 AND user_id=$2",
    [org.id, other.userId, user.userId],
  );
  const accessTask = `${root}/runs/${accessRun.id}/tasks/review`;
  await api.request(`${accessTask}/answer`, {
    cookie: other.cookie,
    method: 'POST',
    status: 403,
    body: answer,
  });
  await expect
    .poll(
      async () =>
        (await api.request(accessTask, { cookie: user.cookie })).body
          .escalatedAt,
      { timeout: 10000 },
    )
    .not.toBeNull();
  expect(await coordination.pending(context)).toEqual(
    expect.arrayContaining([expect.objectContaining({ runId: accessRun.id })]),
  );
  await api.request(`${accessTask}/answer`, {
    cookie: user.cookie,
    method: 'POST',
    body: answer,
  });
  await accessHandle.signal('processDecisionChanged').catch((error) => {
    if (error.name !== 'WorkflowNotFoundError') throw error;
  });
  expect(await accessHandle.result()).toMatchObject({ state: 'ended' });
  await db.owner.query(
    "UPDATE memberships SET status='active',suspended_at=NULL,suspended_by_kind=NULL,suspended_by=NULL,suspension_reason=NULL WHERE tenant_id=$1 AND user_id=$2",
    [org.id, other.userId],
  );
  const closedRun = await freshStart(taskVersion);
  await coordination.coordinate(
    closedRun,
    taskVersion.steps[0],
    [],
    closedRun.createdAt,
  );
  expect(
    await detection.exceptions.resolve(context, caseId, {
      kind: 'human_disposition',
      reason: 'Operator closed the synthetic case.',
      evidenceRefs: ['coordination-case'],
    }),
  ).toBe(true);
  expect(
    await coordination.coordinate(
      closedRun,
      taskVersion.steps[0],
      [],
      closedRun.createdAt,
    ),
  ).toMatchObject({ state: 'cancelled' });
  await api.request(`${root}/runs/${closedRun.id}/tasks/review/answer`, {
    cookie: user.cookie,
    method: 'POST',
    status: 404,
    body: answer,
  });
  const otherOrg = (
    await api.request('/v1/organizations', {
      cookie: other.cookie,
      method: 'POST',
      status: 201,
      body: { name: 'Other', slug: 'other-coordination', dataRegion: 'EU' },
    })
  ).body;
  await api.request(
    `/v1/organizations/${otherOrg.id}/workflows/${version.definition.id}/runs/${run.id}/tasks/review`,
    { cookie: other.cookie, status: 404 },
  );
}, 120000);
