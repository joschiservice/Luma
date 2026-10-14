import { createHash, randomUUID } from 'node:crypto';

import {
  createAdaptiveFieldEffects,
  createAdaptiveFields,
  createAdaptiveFieldWorkflows,
} from '@luma/adaptive/composition';
import { createAuditLog } from '@luma/audit/composition';
import type { TenantContext } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import { canonicalJson } from '@luma/platform';
import { createTenantDatabase } from '@luma/platform/composition';
import { runProcess } from '@luma/workflows';
import {
  compileProcessWorkflow,
  createCodeProcesses,
  createProcessStepStore,
  createWorkflowCatalogStore,
  createWorkflowTriggers,
  createWorkflowTriggerStore,
  parseProcessSnapshot,
} from '@luma/workflows/composition';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createMigratedDatabase } from '../test-support/database.js';
import { createSafetyServices } from './services.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('custom fields in admitted workflows', () => {
  it('reads typed fields, reviews independent approval, dispatches once and verifies freshly; refuses stale, rejected and revoked writes', async () => {
    const db = await createMigratedDatabase(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    const role = `field_workflow_${randomUUID().replaceAll('-', '')}`;
    let runtime: Pool | undefined;
    try {
      const password = randomUUID();
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(
        `GRANT luma_adaptive,luma_desk,luma_execution,luma_policies,luma_audit TO "${role}"`,
      );
      const url = new URL(db.owner.options.connectionString!);
      url.username = role;
      url.password = password;
      runtime = new Pool({ connectionString: url.toString() });
      const database = createTenantDatabase(runtime);
      const tenantId = randomUUID(),
        recordId = randomUUID(),
        requesterId = randomUUID(),
        reviewerId = randomUUID();
      await db.owner.query(
        "INSERT INTO organizations(data_region,id,name,slug,created_at,write_mode) VALUES('AU',$1::uuid,'Shop',$1::text,now(),'writes_enabled')",
        [tenantId],
      );
      await db.owner.query(
        "INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,'order','custom-workflow-order')",
        [recordId, tenantId],
      );
      for (const id of [requesterId, reviewerId]) {
        await db.owner.query(
          "INSERT INTO users(id,name,email,created_at,updated_at) VALUES($1,'Person',$2,now(),now())",
          [id, `${id}@example.test`],
        );
        await db.owner.query(
          "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",
          [randomUUID(), tenantId, id],
        );
      }
      const context = (id: string) =>
        makeTenantContext(
          { userId: id, sessionId: randomUUID() },
          {
            id: tenantId,
            name: 'Shop',
            slug: tenantId,
            dataRegion: 'AU',
            status: 'active',
          },
          builtInMembership(
            { id: randomUUID(), organizationId: tenantId, userId: id },
            'owner',
          ),
          randomUUID(),
        );
      let requester = context(requesterId);
      const reviewer = context(reviewerId);
      const fresh = async (c: TenantContext) =>
        c.actor.id === requesterId ? requester : c;
      const fields = createAdaptiveFields(database, {
        refreshContext: fresh,
        released: async () => true,
        audit: createAuditLog,
      });
      const field = await fields.create(requester, {
        recordType: 'order',
        key: 'approved',
        label: { en: 'Approved', de: 'Freigegeben' },
        type: 'boolean',
        choices: [],
        readPermission: 'adaptive.fields.read',
        writePermission: 'adaptive.fields.write',
        commandId: randomUUID(),
      });
      const effects = createAdaptiveFieldEffects(fields);
      const runs = createWorkflowTriggerStore(database);
      const safety = createSafetyServices(
        database,
        { refreshContext: fresh },
        effects,
        { eligible: (c, b) => adapter.eligible(c, b) },
      );
      const adapter: ReturnType<typeof createAdaptiveFieldWorkflows> =
        createAdaptiveFieldWorkflows(database, {
          fields,
          effects,
          admission: safety.execution,
          provisioning: safety.provisioning,
          policies: safety.policies,
          refreshContext: fresh,
          resolveContext: async () => requester,
          run: runs.run,
          version: async (c, id, v) => {
            const version = await runs.version(c, id, v);

            return version?.format === 'workflow/2' ? version : null;
          },
          outputs: async (c, id) =>
            (await createProcessStepStore(database).list(c, [id])).get(id) ??
            [],
          enabled: true,
        });
      const processes = createCodeProcesses(
        database,
        { resolveWorkflowContext: async () => requester },
        { start: async () => null },
        adapter,
      );
      const version = compileProcessWorkflow({
        schemaVersion: 2,
        definition: {
          id: 'approve-artwork',
          name: 'Approve artwork',
          intent: 'Record reviewed artwork approval',
          category: 'orders',
        },
        version: '1.0.0',
        applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
        inputs: {},
        context: { kind: 'record', fields: {}, maxAgeSeconds: 300 },
        steps: [
          {
            id: 'read',
            kind: 'read',
            source: `adaptive.field.${field.id}`,
            fields: {
              value: 'boolean',
              present: 'boolean',
              revision: 'number',
            },
          },
          {
            id: 'approve',
            kind: 'approval',
            forStep: 'write',
            expiresAfterSeconds: 3600,
          },
          {
            id: 'write',
            kind: 'capability',
            capability: 'adaptive.order.field.write',
            capabilityVersion: '1',
            targetKind: 'order',
            minimumRisk: 'medium',
            parameters: {
              fieldId: { source: 'literal', value: field.id },
              valueJson: { source: 'literal', value: 'true' },
            },
            expectedPostcondition: {
              valueJson: { source: 'literal', value: 'true' },
            },
          },
          {
            id: 'verify',
            kind: 'verification',
            forStep: 'write',
            evaluatorVersion: 'adaptive.field-value/1',
            maxDurationSeconds: 60,
            fields: { matches: 'boolean' },
          },
          { id: 'end', kind: 'end', outcome: 'approved' },
        ],
        provenance: {
          kind: 'native',
          reference: 'custom-field-workflow',
          authoredBy: requesterId,
          evidenceRefs: ['custom-field-workflow'],
        },
      });
      await createWorkflowCatalogStore(database).publish(requester, version);
      expect(processes.supported(version)).toBe(true);
      expect(
        (await processes.vocabulary(requester)).reads?.some(
          (read) => read.source === `adaptive.field.${field.id}`,
        ),
      ).toBe(true);
      const triggers = createWorkflowTriggers({
        store: runs,
        refreshContext: fresh,
        hash: (value) =>
          createHash('sha256').update(canonicalJson(value)).digest('hex'),
        id: randomUUID,
        now: () => new Date(),
        parseSnapshot: (input, source) => {
          if (source.format !== 'workflow/2')
            throw new Error('Expected process');

          return parseProcessSnapshot(input, source);
        },
      });
      const start = () => {
        const occurredAt = new Date().toISOString();

        return triggers.fire(requester, version.definition.id, {
          version: version.version,
          reviewedDigest: version.digest,
          subject: { kind: 'order', id: recordId },
          signal: { kind: 'manual', sourceId: randomUUID(), occurredAt },
          context: {
            inputs: {},
            evidence: {
              kind: 'record',
              facts: {},
              observations: [
                { id: recordId, source: 'luma', observedAt: occurredAt },
              ],
            },
            provenance: { reference: 'manual', capturedAt: occurredAt },
          },
        });
      };
      const run = await start();
      let approvals = 0;
      const result = await runProcess(run, version, processes.activities, {
        now: () => new Date().toISOString(),
        wait: async () => {},
        decisionChanged: async () => {
          approvals++;
          const pending = await adapter.pending(reviewer);
          expect(pending).toHaveLength(1);
          const item = pending[0]!;
          expect(item).toMatchObject({
            canRespond: true,
            beforeValue: null,
            proposedValue: true,
            stale: false,
            status: 'approval_required',
          });
          expect(
            (await adapter.review(requester, run.id, 'write')).canRespond,
          ).toBe(false);
          await expect(
            adapter.respond(requester, run.id, 'write', {
              decisionId: item.decisionId!,
              reviewedActionHash: item.actionHash,
              outcome: 'approved',
            }),
          ).rejects.toMatchObject({ statusCode: 403 });
          await adapter.respond(reviewer, run.id, 'write', {
            decisionId: item.decisionId!,
            reviewedActionHash: item.actionHash,
            outcome: 'approved',
          });

          return true;
        },
      });
      expect(result.state).toBe('verified');
      expect(approvals).toBe(1);
      expect(
        (await fields.readValues(requester, 'order', recordId)).values,
      ).toEqual([expect.objectContaining({ value: true, revision: 1 })]);
      expect(await fields.history(requester, field.id, recordId)).toHaveLength(
        1,
      );
      const write = version.steps.find(
        (
          step,
        ): step is Extract<
          (typeof version.steps)[number],
          { kind: 'capability' }
        > => step.kind === 'capability',
      )!;
      const verify = version.steps.find(
        (
          step,
        ): step is Extract<
          (typeof version.steps)[number],
          { kind: 'verification' }
        > => step.kind === 'verification',
      )!;
      expect(
        (await processes.activities.action(run, version, write, [])).state,
      ).toBe('accepted');
      expect(await fields.history(requester, field.id, recordId)).toHaveLength(
        1,
      );
      await fields.writeValues(requester, 'order', recordId, [
        { fieldId: field.id, value: false, revision: 1 },
      ]);
      expect((await adapter.verify(run, verify, [])).state).toBe('failed');
      const rejected = await start();
      expect(
        (
          await runProcess(rejected, version, processes.activities, {
            now: () => new Date().toISOString(),
            wait: async () => {},
            decisionChanged: async () => {
              const item = await adapter.review(reviewer, rejected.id, 'write');
              await adapter.respond(reviewer, rejected.id, 'write', {
                decisionId: item.decisionId!,
                reviewedActionHash: item.actionHash,
                outcome: 'rejected',
              });

              return true;
            },
          })
        ).state,
      ).toBe('denied');
      expect(
        (await fields.readValues(requester, 'order', recordId)).values[0]
          ?.value,
      ).toBe(false);
      const approvalStep = version.steps.find(
        (
          step,
        ): step is Extract<
          (typeof version.steps)[number],
          { kind: 'approval' }
        > => step.kind === 'approval',
      )!;
      const stale = await start();
      expect(await adapter.decision(stale, approvalStep)).toEqual({
        state: 'pending',
      });
      const staleReview = await adapter.review(reviewer, stale.id, 'write');
      await fields.writeValues(requester, 'order', recordId, [
        { fieldId: field.id, value: false, revision: 2 },
      ]);
      await expect(
        adapter.respond(reviewer, stale.id, 'write', {
          decisionId: staleReview.decisionId!,
          reviewedActionHash: staleReview.actionHash,
          outcome: 'approved',
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const revoked = await start();
      await adapter.bindAction(requester, revoked, version, write, []);
      requester = {
        ...requester,
        permissions: new PermissionSet([
          'orders.read',
          'adaptive.fields.read',
          'actions.propose',
          'workflows.triggers.manage',
        ]),
      };
      await expect(
        processes.activities.action(revoked, version, write, []),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(
        (await createAuditLog(database).list(tenantId, field.id)).filter(
          (e) => e.eventType === 'adaptive.field.value_changed',
        ),
      ).toHaveLength(3);
    } finally {
      await runtime?.end();
      await db.drop();
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  }, 60000);
});
