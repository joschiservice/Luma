import { randomUUID } from 'node:crypto';

import { createWorkflowImprovementControlHarness } from '@luma/application-runtime';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { createTenantDatabase } from '@luma/platform/composition';
import { compileProcessWorkflow } from '@luma/workflows/composition';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { database } from './helpers.mjs';

const tenantId = randomUUID(),
  actorId = randomUUID(),
  reviewerId = randomUUID();
const context = (id) =>
  makeTenantContext(
    { userId: id, sessionId: 'isolated-evaluation' },
    {
      id: tenantId,
      name: 'Evaluation fixture',
      slug: tenantId,
      status: 'active',
      dataRegion: 'EU',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: tenantId, userId: id },
      'owner',
    ),
    randomUUID(),
  );
const source = {
  schemaVersion: 2,
  definition: {
    id: 'captured-stock',
    name: 'Captured stock',
    intent: 'Reserve approved stock',
    category: 'inventory',
  },
  version: '1.0.0',
  applicability: {
    trigger: { kind: 'exception', issueType: 'inventory_mismatch' },
    subjectKind: 'sku',
  },
  inputs: { quantity: 'number' },
  context: {
    kind: 'inventory_mismatch',
    fields: { ready: 'boolean' },
    maxAgeSeconds: 300,
  },
  steps: [
    {
      id: 'stock',
      kind: 'read',
      source: 'inventory',
      fields: { ready: 'boolean' },
    },
    {
      id: 'eligible',
      kind: 'condition',
      field: 'ready',
      equals: true,
      onFalse: 'escalate',
    },
    {
      id: 'review',
      kind: 'approval',
      forStep: 'reserve',
      expiresAfterSeconds: 86400,
    },
    {
      id: 'reserve',
      kind: 'capability',
      capability: 'stock.reserve',
      capabilityVersion: '1',
      targetKind: 'sku',
      minimumRisk: 'medium',
      parameters: { quantity: { source: 'input', field: 'quantity' } },
      expectedPostcondition: { reserved: { source: 'literal', value: true } },
    },
    {
      id: 'verify',
      kind: 'verification',
      forStep: 'reserve',
      evaluatorVersion: 'stock/1',
      maxDurationSeconds: 60,
      fields: { reserved: 'boolean' },
    },
    { id: 'done', kind: 'end', outcome: 'Stock reservation verified' },
  ],
  provenance: {
    kind: 'native',
    reference: 'trusted-synthetic-control-fixture',
    authoredBy: actorId,
    evidenceRefs: ['synthetic:stock'],
  },
};

it('evaluates both exact versions with actual admission, SQL effect dedupe and committed Temporal worker recovery in disposable fixtures', async (t) => {
  const opened = [];
  const evaluator = createWorkflowImprovementControlHarness({
    identity: { refreshContext: async (current) => current },
    open: async (current, _label, signal) => {
      signal.throwIfAborted();
      const db = await database(t);
      await db.migrate();
      signal.throwIfAborted();
      await db.grantRuntime();
      await db.owner.query(
        `GRANT luma_exceptions TO "${new URL(db.runtimeUrl).username}"`,
      );
      const pool = new Pool({ connectionString: db.runtimeUrl });
      const env = await TestWorkflowEnvironment.createLocal();
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await env.teardown();
        await pool.end();
      };
      t.onTestFinished(close);
      if (signal.aborted) {
        await close();
        signal.throwIfAborted();
      }
      await db.owner.query(
        "INSERT INTO organizations(id,name,slug,created_at,write_mode) VALUES($1::uuid,'Evaluation fixture',$2,now(),'writes_enabled')",
        [current.tenantId, current.tenantId],
      );
      for (const id of [actorId, reviewerId]) {
        await db.owner.query(
          "INSERT INTO users(id,name,email,created_at,updated_at) VALUES($1,'Synthetic fixture person',$2,now(),now())",
          [id, `${id}@evaluation.invalid`],
        );
        await db.owner.query(
          "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",
          [randomUUID(), current.tenantId, id],
        );
      }
      opened.push({
        db,
        get closed() {
          return closed;
        },
      });

      return {
        isolated: true,
        database: createTenantDatabase(pool),
        context: context(actorId),
        reviewer: context(reviewerId),
        temporal: {
          address: env.address,
          namespace: 'default',
          dataRegion: 'EU',
          taskQueue: `workflow-control-${randomUUID()}`,
        },
        observedAt: async () =>
          new Date(await env.currentTimeMs()).toISOString(),
        advanceTime: async (_milliseconds, signal) => {
          // This fixture uses the real Temporal server clock. The harness observes committed
          // progress with a deadline while its genuine sticky-queue recovery timer elapses.
          signal.throwIfAborted();
        },
        close,
      };
    },
  });
  const version = compileProcessWorkflow(source);
  const report = await evaluator.evaluate(context(actorId), version, version);
  expect(report.versions.map((item) => item.checks)).toEqual(
    [0, 1].map(() =>
      [
        'admission_success',
        'approval_rejected',
        'role_revoked',
        'foreign_tenant',
        'artifact_revoked',
        'principal_tamper',
        'idempotent_restart',
        'committed_temporal_restart',
      ].map((id) => ({ id, passed: true, applicable: true })),
    ),
  );
  expect(report).toMatchObject({
    passed: true,
    source: 'disposable_committed_fixture',
    baselineDigest: version.digest,
    candidateDigest: version.digest,
  });
  expect(report.versions).toHaveLength(2);
  for (const item of report.versions) {
    expect(item.checks).toEqual(
      [
        'admission_success',
        'approval_rejected',
        'role_revoked',
        'foreign_tenant',
        'artifact_revoked',
        'principal_tamper',
        'idempotent_restart',
        'committed_temporal_restart',
      ].map((id) => ({ id, passed: true, applicable: true })),
    );
    expect(item.effects).toBe(3);
  }
  const sync = compileProcessWorkflow({
    ...source,
    definition: {
      id: 'captured-sync',
      name: 'Captured sync',
      intent: 'Inspect the sync scan',
      category: 'operations',
    },
    applicability: {
      trigger: { kind: 'exception', issueType: 'sync_failure' },
      subjectKind: 'connection',
    },
    inputs: {},
    context: { ...source.context, kind: 'sync_failure' },
    steps: source.steps
      .filter((step) => ['read', 'condition', 'end'].includes(step.kind))
      .map((step) =>
        step.kind === 'end' ? { ...step, outcome: 'Sync observed' } : step,
      ),
    provenance: { ...source.provenance, evidenceRefs: ['synthetic:sync'] },
  });
  const readOnly = await evaluator.evaluate(context(actorId), sync, sync);
  expect(readOnly.passed).toBe(true);
  for (const item of readOnly.versions) {
    expect(item.actions).toBe(0);
    expect(item.effects).toBe(0);
    expect(item.checks).toEqual(
      item.checks.map((check) => ({
        ...check,
        passed: true,
        applicable: check.id === 'committed_temporal_restart',
      })),
    );
  }
  expect(opened.every((fixture) => fixture.closed)).toBe(true);
  for (const [index, fixture] of opened.entries()) {
    expect(
      (
        await fixture.db.owner.query(
          "SELECT count(*) FROM exception_sources WHERE document->>'adapterVersion'='workflow-control-simulator/1'",
        )
      ).rows[0].count,
    ).toBe(index < 2 ? '3' : '0');
    expect(
      (
        await fixture.db.owner.query(
          "SELECT count(*) FROM workflow_process_steps WHERE document->>'kind'='end'",
        )
      ).rows[0].count,
    ).toBe('1');
  }
}, 120000);
