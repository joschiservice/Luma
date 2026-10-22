import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { createWorkflowIdentity } from '@luma/identity/composition';
import { createProcessWorker } from '@luma/workflow-temporal';
import type {
  ProcessActivities,
  ProcessRun,
  ProcessWorkflowVersion,
} from '@luma/workflows';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('workflows acting as a suspended member', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const database = `luma_suspension_test_${suffix}`;
  const login = `luma_suspension_test_${suffix}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const tenantId = randomUUID();
  const principal = randomUUID();
  let owner: Pool;
  let identity: ReturnType<typeof createWorkflowIdentity>;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${database}`;
    owner = new Pool({ connectionString: url.toString() });
    const setup = await admin.connect();
    try {
      await setup.query(
        "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
      );
      await promisify(execFile)(
        process.execPath,
        [new URL('../scripts/migrate.mjs', import.meta.url).pathname],
        { env: { ...process.env, MIGRATION_DATABASE_URL: url.toString() } },
      );
    } finally {
      await setup.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
      setup.release();
    }
    // Identity resolves the principal with the workers' read-only identity role.
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(`GRANT luma_workflow_identity TO "${login}"`);
    url.username = login;
    url.password = password;
    identity = createWorkflowIdentity({ databaseUrl: url.toString() });
    await owner.query(
      "INSERT INTO organizations(id,name,slug,status,data_region,created_at) VALUES($1,'Suspension test','suspension-test','active','AU',now())",
      [tenantId],
    );
    await owner.query(
      "INSERT INTO users(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Workflow owner','owner@example.test',true,now(),now())",
      [principal],
    );
    await owner.query(
      "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'admin',now())",
      [randomUUID(), tenantId, principal],
    );
  }, 60_000);

  afterAll(async () => {
    await identity?.close();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.query(`DROP ROLE IF EXISTS "${login}"`);
    await admin.end();
  });

  const setStatus = (status: 'active' | 'suspended') =>
    owner.query(
      status === 'suspended'
        ? "UPDATE memberships SET status='suspended',suspended_at=now(),suspended_by_kind='staff',suspended_by=$3,suspension_reason='Integration test suspension' WHERE tenant_id=$1 AND user_id=$2"
        : "UPDATE memberships SET status='active',suspended_at=NULL,suspended_by_kind=NULL,suspended_by=NULL,suspension_reason=NULL WHERE tenant_id=$1 AND user_id=$2",
      status === 'suspended'
        ? [tenantId, principal, randomUUID()]
        : [tenantId, principal],
    );

  it('pauses the run while its owner is suspended and finishes once after reactivation', async () => {
    const version: ProcessWorkflowVersion = {
      schemaVersion: 2,
      format: 'workflow/2',
      digest: 'a'.repeat(64),
      definition: {
        id: 'stock',
        name: 'Stock',
        intent: 'Reserve stock',
        category: 'procurement',
      },
      version: '1.0.0',
      applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
      inputs: {},
      context: {
        kind: 'stock',
        fields: { ready: 'boolean' },
        // Skipped workflow time runs ahead of the activities' clock.
        maxAgeSeconds: 86_400,
      },
      steps: [
        {
          id: 'read',
          kind: 'read',
          source: 'stock',
          fields: { ready: 'boolean' },
        },
        {
          id: 'reserve',
          kind: 'capability',
          capability: 'stock.reserve',
          capabilityVersion: '1',
          targetKind: 'order',
          minimumRisk: 'medium',
          parameters: {},
          expectedPostcondition: {
            reserved: { source: 'literal', value: true },
          },
        },
        {
          id: 'verify',
          kind: 'verification',
          forStep: 'reserve',
          evaluatorVersion: '1',
          maxDurationSeconds: 60,
          fields: { reserved: 'boolean' },
        },
        { id: 'end', kind: 'end', outcome: 'reserved' },
      ],
      provenance: {
        kind: 'resolution',
        reference: 'test',
        authoredBy: 'test',
        evidenceRefs: ['stock'],
      },
    };
    const run: ProcessRun = {
      id: randomUUID(),
      tenantId,
      definitionId: 'stock',
      version: version.version,
      versionDigest: version.digest,
      subject: { kind: 'order', id: randomUUID() },
      actor: { kind: 'user', id: principal },
      context: {
        inputs: {},
        evidence: {
          kind: 'stock',
          facts: { ready: true },
          observations: [
            {
              id: randomUUID(),
              observedAt: new Date().toISOString(),
              source: 'stock',
            },
          ],
        },
        provenance: {
          reference: 'test',
          capturedAt: new Date().toISOString(),
        },
      },
      contextDigest: 'test',
      createdAt: new Date().toISOString(),
    };
    const rejected: string[] = [];
    const effects: string[] = [];
    // Like production activities, each step rebuilds the principal's context before acting.
    const asPrincipal = async (step: string) => {
      try {
        await identity.service.resolveWorkflowContext(
          principal,
          tenantId,
          run.id,
        );
      } catch (error) {
        rejected.push(step);
        throw error;
      }
    };
    const activities: ProcessActivities = {
      read: async () => {
        await asPrincipal('read');

        return {
          values: { ready: true },
          evidenceRefs: ['stock-read'],
          observedAt: new Date().toISOString(),
        };
      },
      decision: async () => ({ state: 'approved', decisionId: 'decision' }),
      action: async () => {
        await asPrincipal('reserve');
        effects.push('reserve');

        return {
          state: 'accepted',
          proposalId: 'proposal',
          receiptId: 'receipt',
        };
      },
      verify: async () => {
        await asPrincipal('verify');

        return {
          state: 'verified',
          values: { reserved: true },
          evidenceRefs: ['stock-verify'],
        };
      },
      record: async () => undefined,
    };
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const taskQueue = randomUUID();
    // The production worker wraps activities the same way, mapping suspension to a pause.
    const worker = await createProcessWorker(
      {
        address: env.address,
        namespace: 'default',
        taskQueue,
        dataRegion: 'AU',
      },
      activities,
    );
    const running = worker.run();
    try {
      await setStatus('suspended');
      const handle = await env.client.workflow.start('processWorkflow', {
        workflowId: randomUUID(),
        taskQueue,
        args: [{ ...run, dataRegion: 'AU' }, version],
      });
      // The first step is rejected without effect, and the run waits instead of failing.
      await expect.poll(() => rejected.length, { timeout: 20_000 }).toBe(1);
      await env.sleep(3 * 60_000);
      await expect
        .poll(() => rejected.length, { timeout: 20_000 })
        .toBeGreaterThan(1);
      expect(rejected.every((step) => step === 'read')).toBe(true);
      expect((await handle.describe()).status.name).toBe('RUNNING');
      expect(effects).toEqual([]);

      await setStatus('active');
      expect(await handle.result()).toMatchObject({
        state: 'verified',
        stepId: 'end',
      });
      expect(effects).toEqual(['reserve']);
    } finally {
      await setStatus('active');
      worker.shutdown();
      await running;
      await worker.close();
      await env.teardown();
    }
  }, 120_000);
});
