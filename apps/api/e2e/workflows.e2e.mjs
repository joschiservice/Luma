import { randomUUID } from 'node:crypto';

import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { shippingMethodPlaybook } from '@luma/resolution';
import { resolutionWorkflow } from '@luma/workflows';
import {
  compilePlaybook,
  compileProcessWorkflow,
  createProcessStepStore,
  createWorkflows,
  defineWorkflow,
} from '@luma/workflows/composition';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { database, signup, startApi } from './helpers.mjs';
import { seedPlaybooks } from './playbooks-fixture.mjs';

it('publishes native workflows without cases, retains immutable versions and exposes both formats through the Workflow catalog', async (t) => {
  const db = await database(t);
  await db.migrate();
  await db.owner.query(
    `GRANT luma_identity,luma_connectors,luma_case_reader,luma_desk TO "${new URL(db.runtimeUrl).username}"`,
  );
  const api = await startApi(t, db);
  const user = await signup(api, 'workflow-author');
  const org = (
    await api.request('/v1/organizations', {
      cookie: user.cookie,
      method: 'POST',
      status: 201,
      body: { name: 'Workflows', slug: 'workflows', dataRegion: 'EU' },
    })
  ).body;
  const tenantId = org.id;
  const membership = (
    await db.owner.query(
      'SELECT id FROM memberships WHERE tenant_id=$1 AND user_id=$2',
      [tenantId, user.userId],
    )
  ).rows[0];
  const context = makeTenantContext(
    { userId: user.userId, sessionId: 'test' },
    { ...org, status: 'active' },
    builtInMembership(
      { id: membership.id, organizationId: tenantId, userId: user.userId },
      'owner',
    ),
    'publication',
  );
  const pool = new Pool({ connectionString: db.runtimeUrl });
  t.onTestFinished(() => pool.end());
  const tenantDb = createTenantDatabase(pool);
  // Publication only uses the owner store and refreshed membership, never execution controls.
  const catalog = createWorkflows(tenantDb, {}, async () => context, {
    approvalRequirement: async () => ({
      mode: 'every_action',
      reason: 'minimum_risk',
    }),
  });
  const projected = resolutionWorkflow(compilePlaybook(shippingMethodPlaybook));
  const { digest, format, ...source } = projected;
  expect(digest).toHaveLength(64);
  expect(format).toBe('resolution-playbook/0');
  const native = defineWorkflow({
    ...source,
    definition: {
      ...source.definition,
      id: 'manual-order-review',
      category: 'operations',
    },
    applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
  });
  expect(await catalog.publish(context, native)).toEqual(native);
  expect(await catalog.publish(context, native)).toEqual(native);
  await expect(
    catalog.publish(context, {
      ...source,
      definition: native.definition,
      applicability: native.applicability,
      inputs: { ...source.inputs, reviewId: 'string' },
    }),
  ).rejects.toThrow('version is immutable');
  const legacy = await seedPlaybooks(db, tenantId);
  const root = `/v1/organizations/${tenantId}`;
  const items = (
    await api.request(`${root}/workflows`, { cookie: user.cookie })
  ).body.items;
  expect(items.map((v) => v.id).sort()).toEqual(
    [
      'inventory-replenishment',
      'connection-sync-check',
      'shopify-stock-correction',
      'shopify-hold-release',
      'supplier-follow-up',
      'refund-follow-up',
      'payment-follow-up',
      native.definition.id,
      legacy.version.definition.id,
    ].sort(),
  );
  const detail = (
    await api.request(`${root}/workflows/${native.definition.id}`, {
      cookie: user.cookie,
    })
  ).body;
  expect(detail.summary).toMatchObject({
    category: 'operations',
    status: 'unavailable',
  });
  expect(detail.versions[0]).toMatchObject({
    digest: native.digest,
    format: 'workflow/1',
    applicability: native.applicability,
    compatible: false,
  });
  expect(
    (
      await api.request(`${root}/workflows/${native.definition.id}/runs`, {
        cookie: user.cookie,
      })
    ).body.items,
  ).toEqual([]);
  expect(
    (await api.request(`${root}/playbooks`, { cookie: user.cookie })).body
      .items,
  ).toHaveLength(1);
  await api.request(`${root}/workflows/${native.definition.id}/activations`, {
    cookie: user.cookie,
    method: 'POST',
    status: 409,
    body: {
      id: randomUUID(),
      version: native.version,
      reviewedDigest: native.digest,
      policyVersion: 'v0.1',
      connectionId: legacy.connectionId,
      connectionVersion: 2,
      targetIds: [legacy.targetId],
      scopeReviewed: true,
    },
  });
  const outsider = await signup(api, 'workflow-outsider');
  await api.request(`${root}/workflows/${native.definition.id}`, {
    cookie: outsider.cookie,
    status: 404,
  });
  // Caller-supplied actors never create an agent authorization path.
  await api.request(
    `${root}/workflows/${legacy.version.definition.id}/activations`,
    {
      cookie: user.cookie,
      method: 'POST',
      status: 400,
      body: {
        id: randomUUID(),
        version: legacy.version.version,
        reviewedDigest: legacy.version.digest,
        policyVersion: 'v0.1',
        connectionId: legacy.connectionId,
        connectionVersion: 2,
        targetIds: [legacy.targetId],
        scopeReviewed: true,
        actor: { kind: 'agent', id: 'agent' },
      },
    },
  );
  const now = new Date().toISOString();
  const start = {
    version: native.version,
    reviewedDigest: native.digest,
    subject: { kind: 'order', id: legacy.targetId },
    signal: { kind: 'manual', sourceId: 'manual-1', occurredAt: now },
    context: {
      inputs: { shippingMethodId: 'standard' },
      evidence: {
        kind: 'workflow_failure',
        facts: { diagnosisReady: true, methodMapped: true },
        observations: [{ id: randomUUID(), observedAt: now, source: 'test' }],
      },
      provenance: { reference: 'manual-1', capturedAt: now },
    },
  };
  const starts = `${root}/workflows/${native.definition.id}/starts`;
  const fire = (body, status = 200, cookie = user.cookie) =>
    api.request(starts, { cookie, method: 'POST', status, body });
  const [first, retry] = await Promise.all([fire(start), fire(start)]);
  expect(first.body.id).toBe(retry.body.id);
  expect(first.body).toMatchObject({
    activationId: null,
    triggerState: 'awaiting_admission',
    versionDigest: native.digest,
    subject: start.subject,
    triggerEvidence: { sourceId: 'manual-1', occurredAt: now },
    execution: 'not_recorded',
  });
  await fire(
    {
      ...start,
      context: { ...start.context, inputs: { shippingMethodId: 'express' } },
    },
    409,
  );
  await fire(
    {
      ...start,
      signal: { ...start.signal, sourceId: 'bad-type' },
      context: { ...start.context, inputs: { shippingMethodId: 42 } },
    },
    409,
  );
  await fire(start, 404, outsider.cookie);
  await fire({ ...start, actor: { kind: 'user', id: outsider.userId } }, 400);
  const before = await db.owner.query(
    'SELECT count(*) FROM playbook_activations WHERE tenant_id=$1',
    [tenantId],
  );
  for (const [versionNumber, trigger] of [
    ['0.2.0', { kind: 'event', eventType: 'workflow_failure' }],
    ['0.3.0', { kind: 'condition', field: 'diagnosisReady', equals: true }],
    [
      '0.4.0',
      { kind: 'schedule', at: new Date(Date.now() + 2000).toISOString() },
    ],
  ]) {
    const version = await catalog.publish(context, {
      ...source,
      definition: native.definition,
      version: versionNumber,
      applicability: { subjectKind: 'order', trigger },
    });
    const body = {
      ...start,
      version: version.version,
      reviewedDigest: version.digest,
      signal: {
        ...start.signal,
        kind: trigger.kind,
        sourceId: `source-${versionNumber}`,
      },
    };
    if (trigger.kind === 'condition')
      await fire(
        {
          ...body,
          context: {
            ...body.context,
            evidence: {
              ...body.context.evidence,
              facts: { diagnosisReady: false, methodMapped: true },
            },
          },
        },
        409,
      );
    if (trigger.kind === 'event') {
      await fire(
        {
          ...body,
          signal: {
            ...body.signal,
            sourceId: 'old-event',
            occurredAt: '2020-01-01T00:00:00Z',
          },
        },
        409,
      );
    }
    const result = await fire(body);
    expect((await fire(body)).body.id).toBe(result.body.id);
    if (trigger.kind === 'schedule') {
      expect(result.body.triggerState).toBe('scheduled');
      await pool.query('SELECT advance_workflow_schedules()');
      expect((await fire(body)).body.triggerState).toBe('scheduled');
      // A different resource is a separate scheduled start; cancellation is durable and idempotent.
      const cancelled = await fire({
        ...body,
        subject: { ...body.subject, id: randomUUID() },
      });
      const cancel = `${starts}/${cancelled.body.id}/cancel`;
      await api.request(cancel, {
        cookie: user.cookie,
        method: 'POST',
        body: {},
      });
      await api.request(cancel, {
        cookie: user.cookie,
        method: 'POST',
        body: {},
      });
      await new Promise((resolve) => setTimeout(resolve, 2100));
      const restartingWorker = await pool.connect();
      try {
        await restartingWorker.query('BEGIN');
        await restartingWorker.query('SELECT advance_workflow_schedules()');
        await restartingWorker.query('ROLLBACK');
      } finally {
        restartingWorker.release();
      }
      expect((await fire(body)).body.triggerState).toBe('scheduled');
      await Promise.all([
        pool.query('SELECT advance_workflow_schedules()'),
        pool.query('SELECT advance_workflow_schedules()'),
      ]);
      expect((await fire(body)).body.triggerState).toBe('awaiting_admission');
      await api.request(`${starts}/${result.body.id}/cancel`, {
        cookie: user.cookie,
        method: 'POST',
        body: {},
        status: 409,
      });
      const history = (
        await api.request(`${root}/workflows/${native.definition.id}/runs`, {
          cookie: user.cookie,
        })
      ).body.items;
      expect(history.find((r) => r.id === cancelled.body.id).triggerState).toBe(
        'cancelled',
      );
      expect(
        history.find((r) => r.id === result.body.id).triggeredAt,
      ).toBeTruthy();
    }
  }
  expect(
    (
      await db.owner.query(
        'SELECT count(*) FROM playbook_activations WHERE tenant_id=$1',
        [tenantId],
      )
    ).rows,
  ).toEqual(before.rows);
  const isolated = await tenantDb.transaction(randomUUID(), (tx) =>
    tx.query('SELECT id FROM workflow_trigger_runs'),
  );
  expect(isolated.rows).toEqual([]);

  const process = compileProcessWorkflow({
    schemaVersion: 2,
    definition: {
      id: 'stock-review',
      name: 'Stock review',
      intent: 'Review current stock',
      category: 'procurement',
    },
    version: '1.0.0',
    applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
    inputs: {},
    context: {
      kind: 'stock',
      fields: { ready: 'boolean' },
      maxAgeSeconds: 300,
    },
    steps: [
      {
        id: 'refresh',
        kind: 'read',
        source: 'stock',
        fields: { ready: 'boolean' },
      },
      {
        id: 'check',
        kind: 'condition',
        field: 'ready',
        equals: true,
        onFalse: 'escalate',
      },
      { id: 'finish', kind: 'end', outcome: 'reviewed' },
    ],
    provenance: {
      kind: 'resolution',
      reference: 'fixture',
      authoredBy: 'operator',
      evidenceRefs: ['stock'],
    },
  });
  await catalog.publish(context, process);
  const processDetail = (
    await api.request(`${root}/workflows/${process.definition.id}`, {
      cookie: user.cookie,
    })
  ).body;
  expect(processDetail.versions[0]).toMatchObject({
    format: 'workflow/2',
    digest: process.digest,
    steps: [{ id: 'refresh' }, { id: 'check' }, { id: 'finish' }],
  });
  const started = (
    await api.request(`${root}/workflows/${process.definition.id}/starts`, {
      cookie: user.cookie,
      method: 'POST',
      body: {
        version: process.version,
        reviewedDigest: process.digest,
        subject: { kind: 'order', id: legacy.targetId },
        signal: { kind: 'manual', sourceId: 'stock-review', occurredAt: now },
        context: {
          inputs: {},
          evidence: {
            kind: 'stock',
            facts: { ready: true },
            observations: [
              { id: randomUUID(), observedAt: now, source: 'stock' },
            ],
          },
          provenance: { reference: 'stock-review', capturedAt: now },
        },
      },
    })
  ).body;
  const stepStore = createProcessStepStore(tenantDb);
  await expect(
    stepStore.record(context, started.id, {
      stepId: 'finish',
      kind: 'end',
      state: 'completed',
      values: { outcome: 'reviewed' },
      evidenceRefs: [`temporal:${started.id}:finish`],
      recordedAt: now,
    }),
  ).rejects.toThrow('out of order');
  await stepStore.record(context, started.id, {
    stepId: 'refresh',
    kind: 'read',
    state: 'completed',
    values: { ready: true },
    evidenceRefs: ['stock-read'],
    recordedAt: now,
    observedAt: now,
  });
  await expect(
    stepStore.record(context, started.id, {
      stepId: 'refresh',
      kind: 'read',
      state: 'completed',
      values: { ready: false },
      evidenceRefs: ['stock-read'],
      recordedAt: now,
      observedAt: now,
    }),
  ).rejects.toThrow('replay conflicts');
  await stepStore.record(context, started.id, {
    stepId: 'check',
    kind: 'condition',
    state: 'completed',
    values: { matched: true },
    evidenceRefs: ['stock-read'],
    recordedAt: now,
  });
  await stepStore.record(context, started.id, {
    stepId: 'finish',
    kind: 'end',
    state: 'completed',
    values: { outcome: 'reviewed' },
    evidenceRefs: [`temporal:${started.id}:finish`],
    recordedAt: now,
  });
  const processRuns = (
    await api.request(`${root}/workflows/${process.definition.id}/runs`, {
      cookie: user.cookie,
    })
  ).body.items;
  expect(processRuns[0]).toMatchObject({
    processState: 'ended',
    processSteps: [
      { stepId: 'refresh' },
      { stepId: 'check' },
      { stepId: 'finish' },
    ],
  });

  await db.owner.query(
    "UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",
    [tenantId, user.userId],
  );
  await fire(
    { ...start, signal: { ...start.signal, sourceId: 'member-start' } },
    403,
  );
  await api.request(`${root}/workflows/${native.definition.id}/runs`, {
    cookie: user.cookie,
  });
});
