import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import {
  buildRuntimeApp,
  createExceptionWorkflowRuntime,
  createResolutionPlaybooks,
  createSafetyServices as createAdmissionServices,
} from '@luma/application-runtime';
import type { AuditEntry } from '@luma/audit';
import { createAuditLog } from '@luma/audit/composition';
import { ConnectorError } from '@luma/connections';
import { createInstalledConnections } from '@luma/connections/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { shippingMethodPlaybook } from '@luma/resolution';
import {
  definePlaybook,
  parsePlaybookCode,
  printPlaybookCode,
} from '@luma/resolution/composition';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createSafetyFixture as createSafetyServices } from './test-support/safety-fixtures.js';

type Safety = ReturnType<typeof createSafetyServices>;

type TenantContext = Parameters<Safety['execution']['execute']>[0];

type EffectRegistry = Parameters<typeof createSafetyServices>[2];

type EffectAdapter = NonNullable<
  Awaited<ReturnType<EffectRegistry['resolve']>>
>;

type ProposedAction = Extract<
  Awaited<ReturnType<Safety['execution']['execute']>>,
  { record: unknown }
>['record']['intent'];

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  'durable policy, execution and audit on PostgreSQL',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const database = `safety_${suffix}`;
    const login = `safety_${suffix}`;
    const password = randomUUID();
    const admin = new Pool({ connectionString: databaseUrl });
    let owner: Pool;
    let runtime: Pool;
    let app: Awaited<ReturnType<typeof buildRuntimeApp>>;
    let safety: ReturnType<typeof createSafetyServices>;
    let runtimeUrl: string;
    const origin = 'http://localhost:3001';
    const cookies = new Map<string, string>();
    let tenantId: string;
    let alice: TenantContext;
    let bob: TenantContext;
    let member: TenantContext;
    let outsider: TenantContext;
    let bobMembership: string;
    const connectionId = randomUUID();
    const observationId = randomUUID();
    const execute = vi.fn<EffectAdapter['execute']>();
    const verify = vi.fn<EffectAdapter['verify']>();
    const checkPreconditions = vi.fn<EffectAdapter['checkPreconditions']>();
    const adapter: EffectAdapter = {
      capability: 'stock.correct',
      version: '1',
      minimumRisk: 'low',
      mechanism: 'api',
      executor: { kind: 'connector', id: 'fixture-v1' },
      execute,
      verify,
      checkPreconditions,
    };
    const resolve = vi.fn<EffectRegistry['resolve']>();

    async function context(cookie: string, organizationId: string) {
      const response = await app.inject({
        url: `/v1/organizations/${organizationId}/capture`,
        headers: { cookie, origin },
      });
      const captured = contexts.get(response.json().requestId);
      if (response.statusCode !== 200 || !captured)
        throw new Error('Context unavailable');

      return captured;
    }

    const contexts = new Map<string, TenantContext>();
    const refreshContext = (value: TenantContext) =>
      context(cookies.get(value.actor.id)!, value.tenantId);
    const startSafety = () =>
      createSafetyServices(runtimeUrl, { refreshContext }, { resolve });

    function action(overrides: Partial<ProposedAction> = {}): ProposedAction {
      return {
        schemaVersion: 1,
        id: randomUUID(),
        tenantId,
        capability: 'stock.correct',
        capabilityVersion: '1',
        connectionId,
        target: { kind: 'sku', id: randomUUID() },
        parameters: { quantity: 3 },
        preconditions: {
          evidenceRefs: [observationId],
          validUntil: new Date(Date.now() + 60_000).toISOString(),
        },
        expectedPostcondition: { quantity: 3 },
        risk: 'low',
        proposedBy: { kind: 'user', id: alice.actor.id },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...overrides,
      };
    }

    async function signup(name: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        headers: { origin },
        payload: {
          name,
          email: `${name}@example.test`,
          dataRegion: 'AU',
          password: 'long-test-password',
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      // The emailed confirmation link would set this before the first sign-in.
      await owner.query('UPDATE users SET email_verified=true WHERE email=$1', [
        `${name}@example.test`,
      ]);
      const signedIn = await app.inject({
        method: 'POST',
        url: '/auth/sign-in/email',
        headers: { origin },
        payload: {
          email: `${name}@example.test`,
          password: 'long-test-password',
        },
      });
      expect(signedIn.statusCode, signedIn.body).toBe(200);
      const raw = signedIn.headers['set-cookie'];
      const cookie = (Array.isArray(raw) ? raw : [raw!])
        .map((value) => value.split(';')[0])
        .join('; ');
      const id = response.json().user.id as string;
      cookies.set(id, cookie);

      return { id, cookie };
    }

    async function organization(cookie: string, slug: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie, origin },
        payload: { name: slug, slug },
      });
      expect(response.statusCode, response.body).toBe(201);

      return response.json().id as string;
    }

    async function audit(proposalId: string) {
      return (
        await owner.query(
          'SELECT document FROM audit_entries WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY created_at',
          [tenantId, proposalId],
        )
      ).rows.map((row) => row.document);
    }

    async function admitted(
      proposal = action(),
      eligible = true,
      permission: Partial<{
        capabilityVersion: string;
        targetKind: string;
        minimumRisk: 'low' | 'medium' | 'high';
      }> = {},
    ) {
      const service = createAdmissionServices(
        runtimeUrl,
        { refreshContext },
        { resolve },
        { eligible: async () => eligible },
      );
      const artifact = await service.provisioning.activate(alice, {
        id: 'admission-test',
        version: randomUUID(),
        generation: { kind: 'generated', reference: 'untrusted-author/1' },
        steps: {
          execute: {
            capability: 'stock.correct',
            capabilityVersion: '1',
            targetKind: 'sku',
            minimumRisk: 'low',
            ...permission,
          },
        },
      });
      const step = {
        runId: proposal.id,
        stepId: 'execute',
        tenantId,
        principalId: alice.actor.id,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        incidentId: randomUUID(),
        diagnosisRevision: 1,
        action: proposal,
      };
      await service.provisioning.bind(alice, step);

      return {
        service,
        artifact,
        step,
        reference: { runId: step.runId, stepId: step.stepId },
      };
    }

    it('withholds dispatch when an expected provider value changes after policy evaluation', async () => {
      const f = await admitted();
      try {
        checkPreconditions
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false);
        const result = await f.service.execution.execute(alice, {
          runId: f.step.runId,
          stepId: f.step.stepId,
        });
        expect(result.state).toBe('failed');
        if ('record' in result)
          expect(result.record.attempt.dispatch).toBe('not_dispatched');
        expect(execute).not.toHaveBeenCalled();
        expect(
          (await audit(f.step.action.id)).find(
            (entry: AuditEntry) => entry.eventType === 'execution.withheld',
          )?.details.reason,
        ).toBe('stale_precondition');
      } finally {
        await f.service.close();
      }
    });

    it('admits concurrent logical requests once and retains provider, artifact and audit identity', async () => {
      const f = await admitted();
      execute.mockResolvedValue({
        evidenceRefs: [observationId],
        providerRequestId: 'provider-request-42',
      });
      try {
        await Promise.all(
          Array.from({ length: 5 }, () =>
            f.service.execution.execute(alice, f.reference),
          ),
        );
        const result = await f.service.execution.execute(alice, f.reference);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
          state: 'succeeded',
          record: {
            idempotencyKey: `v0:${f.step.action.id}`,
            admission: {
              runId: f.step.runId,
              artifactDigest: f.artifact.digest,
              generation: { kind: 'generated' },
            },
            attempt: {
              dispatch: 'dispatched',
              businessOutcome: 'satisfied',
              providerRequestId: 'provider-request-42',
              requestedBy: alice.actor.id,
            },
          },
        });
        const entries = await audit(f.step.action.id);
        expect(
          entries.find((entry) => entry.eventType === 'execution.prepared')
            ?.details,
        ).toMatchObject({
          runId: f.step.runId,
          artifactDigest: f.artifact.digest,
        });
        expect(
          entries.find((entry) => entry.eventType === 'execution.completed')
            ?.details,
        ).toMatchObject({
          dispatch: 'dispatched',
          businessOutcome: 'satisfied',
          providerRequestId: 'provider-request-42',
        });
      } finally {
        await f.service.close();
      }
    });
    it('rejects raw actions, injected authority and foreign references with zero writes', async () => {
      const f = await admitted();
      try {
        for (const input of [
          f.step.action,
          { ...f.reference, tenantId },
          { ...f.reference, parameters: { quantity: 99 } },
          { ...f.reference, capability: 'arbitrary.write' },
          { ...f.reference, stepId: 'foreign' },
          { ...f.reference, runId: randomUUID() },
        ])
          await expect(
            f.service.execution.execute(alice, input),
          ).rejects.toThrow();
        await expect(
          f.service.execution.execute(outsider, f.reference),
        ).rejects.toThrow();
        await expect(
          f.service.execution.execute(bob, f.reference),
        ).rejects.toThrow();
        await expect(
          f.service.execution.execute(member, f.reference),
        ).rejects.toThrow();
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await f.service.close();
      }
    });
    it('fails closed without an independent eligibility reader', async () => {
      const f = await admitted();
      const closed = createAdmissionServices(
        runtimeUrl,
        { refreshContext },
        { resolve },
      );
      try {
        await expect(
          closed.execution.execute(alice, f.reference),
        ).rejects.toThrow('eligible');
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await Promise.all([f.service.close(), closed.close()]);
      }
    });
    it('rejects revoked artifacts, changed bindings and foreign target mappings', async () => {
      const f = await admitted();
      try {
        await expect(
          f.service.provisioning.bind(alice, {
            ...f.step,
            action: { ...f.step.action, id: randomUUID() },
          }),
        ).rejects.toThrow('already bound');
        await expect(
          f.service.provisioning.bind(alice, {
            ...f.step,
            runId: randomUUID(),
          }),
        ).rejects.toThrow('already bound');
        await expect(
          f.service.provisioning.bind(outsider, f.step),
        ).rejects.toThrow();
        resolve.mockResolvedValue(null);
        expect(
          await f.service.execution.execute(alice, f.reference),
        ).toMatchObject({ state: 'denied' });
        await f.service.provisioning.revoke(
          alice,
          f.artifact.id,
          f.artifact.version,
        );
        await expect(
          f.service.execution.execute(alice, f.reference),
        ).rejects.toThrow('activated artifact');
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await f.service.close();
      }
    });
    it('independently enforces policy denial, evidence freshness and approval risk', async () => {
      const f = await admitted(action({ risk: 'high' }));
      try {
        checkPreconditions.mockResolvedValue(false);
        expect(
          await f.service.execution.execute(alice, f.reference),
        ).toMatchObject({ state: 'denied' });
        checkPreconditions.mockResolvedValue(true);
        expect(
          await f.service.execution.execute(alice, f.reference),
        ).toMatchObject({ state: 'approval_required' });
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await f.service.close();
      }
      const stale = await admitted(
        action({
          preconditions: {
            evidenceRefs: [observationId],
            validUntil: new Date(Date.now() - 1000).toISOString(),
          },
        }),
      );
      try {
        expect(
          await stale.service.execution.execute(alice, stale.reference),
        ).toMatchObject({ state: 'denied' });
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await stale.service.close();
      }
    });
    it('reconciles uncertain admission without a second dispatch', async () => {
      const f = await admitted();
      execute.mockRejectedValue(
        new ConnectorError({
          code: 'timeout',
          effect: 'unknown',
          retry: 'reconcile',
          providerRequestId: 'lost-response-42',
        }),
      );
      try {
        expect(
          await f.service.execution.execute(alice, f.reference),
        ).toMatchObject({
          state: 'reconciliation_required',
          record: {
            attempt: {
              dispatch: 'uncertain',
              businessOutcome: 'inconclusive',
              providerRequestId: 'lost-response-42',
            },
          },
        });
        await f.service.execution.execute(alice, f.reference);
        expect(
          await f.service.execution.reconcile(alice, f.step.action.id),
        ).toMatchObject({
          state: 'succeeded',
          record: {
            attempt: { dispatch: 'uncertain', businessOutcome: 'satisfied' },
          },
        });
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        await f.service.close();
      }
    });
    it('keeps provider acceptance separate from failed business verification', async () => {
      const f = await admitted();
      verify.mockImplementation(async () => ({
        outcome: 'failed',
        observationRefs: [observationId],
        observedAt: new Date().toISOString(),
        evaluatorVersion: 'business/1',
      }));
      try {
        expect(
          await f.service.execution.execute(alice, f.reference),
        ).toMatchObject({
          state: 'failed',
          record: {
            attempt: { dispatch: 'dispatched', businessOutcome: 'violated' },
          },
        });
      } finally {
        await f.service.close();
      }
    });
    it.each([
      { capabilityVersion: '2' },
      { targetKind: 'order' },
      { minimumRisk: 'high' as const },
    ])('rejects artifact permission mismatch %j', async (permission) => {
      const f = await admitted(action(), true, permission);
      try {
        await expect(
          f.service.execution.execute(alice, f.reference),
        ).rejects.toThrow('activated artifact');
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await f.service.close();
      }
    });
    it('withholds a reserved action if activation is revoked during policy checks', async () => {
      const f = await admitted();
      checkPreconditions.mockImplementation(async () => {
        await f.service.provisioning.revoke(
          alice,
          f.artifact.id,
          f.artifact.version,
        );

        return true;
      });
      try {
        expect(
          await f.service.execution.execute(alice, f.reference),
        ).toMatchObject({
          state: 'failed',
          record: {
            attempt: {
              dispatch: 'not_dispatched',
              businessOutcome: 'inconclusive',
            },
          },
        });
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await f.service.close();
      }
    });
    it.each(['api', 'deterministic_browser', 'sandboxed_code'] as const)(
      'applies approval and reservation to %s adapters',
      async (mechanism) => {
        const f = await admitted(action({ risk: 'high' }));
        const original = adapter.mechanism;
        adapter.mechanism = mechanism;
        try {
          const waiting = await f.service.execution.execute(alice, f.reference);
          expect(waiting.state).toBe('approval_required');
          expect(execute).not.toHaveBeenCalled();
          if (waiting.state !== 'approval_required')
            throw new Error('Expected approval');
          await f.service.policies.respond(
            bob,
            waiting.decision.id,
            'approved',
            new Date(Date.now() + 60000).toISOString(),
          );
          expect(
            await f.service.execution.execute(alice, f.reference),
          ).toMatchObject({
            state: 'succeeded',
            record: { attempt: { mechanism, dispatch: 'dispatched' } },
          });
          await f.service.execution.execute(alice, f.reference);
          expect(execute).toHaveBeenCalledTimes(1);
        } finally {
          adapter.mechanism = original;
          await f.service.close();
        }
      },
    );
    it('persists inconclusive reconciliation and rejects a changed provider identity', async () => {
      const f = await admitted();
      adapter.dispatchIdentity = 'provider/1';
      execute.mockRejectedValue(new Error('lost response'));
      try {
        await f.service.execution.execute(alice, f.reference);
        verify.mockImplementation(async () => ({
          outcome: 'inconclusive',
          observationRefs: [observationId],
          observedAt: new Date().toISOString(),
          evaluatorVersion: 'recovery/1',
        }));
        expect(
          await f.service.execution.reconcile(alice, f.step.action.id),
        ).toMatchObject({
          state: 'reconciliation_required',
          record: {
            attempt: {
              dispatchIdentity: 'provider/1',
              verification: { evaluatorVersion: 'recovery/1' },
            },
          },
        });
        expect(
          (await audit(f.step.action.id)).find(
            (entry) => entry.eventType === 'execution.reconciled',
          )?.evidenceRefs,
        ).toContain(observationId);
        adapter.dispatchIdentity = 'provider/2';
        await expect(
          f.service.execution.reconcile(alice, f.step.action.id),
        ).rejects.toThrow('unavailable');
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        delete adapter.dispatchIdentity;
        await f.service.close();
      }
    });
    it('isolates and protects run and artifact documents under the runtime database role', async () => {
      const f = await admitted();
      try {
        expect(
          await f.service.provisioning.step(
            outsider,
            f.step.runId,
            f.step.stepId,
          ),
        ).toBeNull();
        expect(
          await f.service.provisioning.artifact(
            outsider,
            f.artifact.id,
            f.artifact.version,
          ),
        ).toBeNull();
        await expect(
          f.service.provisioning.bind(alice, {
            ...f.step,
            stepId: 'another',
            action: action(),
            diagnosisRevision: 2,
          }),
        ).rejects.toThrow('Run authority');
        const db = createTenantDatabase(runtime);
        for (const table of [
          'action_artifacts',
          'action_admission_runs',
          'action_admission_steps',
        ]) {
          await expect(
            db.transaction(tenantId, (tx) =>
              tx.query(
                `UPDATE ${table} SET document='{}'::jsonb WHERE tenant_id=$1`,
                [tenantId],
              ),
            ),
          ).rejects.toThrow('permission denied');
          await expect(
            db.transaction(tenantId, (tx) =>
              tx.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]),
            ),
          ).rejects.toThrow('permission denied');
        }
        await f.service.provisioning.revoke(
          alice,
          f.artifact.id,
          f.artifact.version,
        );
        await expect(
          db.transaction(tenantId, (tx) =>
            tx.query(
              'UPDATE action_artifacts SET active=true WHERE tenant_id=$1 AND id=$2 AND version=$3',
              [tenantId, f.artifact.id, f.artifact.version],
            ),
          ),
        ).rejects.toThrow('cannot be reactivated');
      } finally {
        await f.service.close();
      }
    });
    beforeAll(async () => {
      await admin.query(`CREATE DATABASE "${database}"`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${database}`;
      owner = new Pool({ connectionString: url.toString() });
      const roleSetup = await admin.connect();
      try {
        await roleSetup.query(
          "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
        );
        for (const name of (
          await readdir(new URL('../migrations/', import.meta.url))
        )
          .filter((name) => name.endsWith('.sql'))
          .sort()) {
          await owner.query(
            await readFile(
              new URL(`../migrations/${name}`, import.meta.url),
              'utf8',
            ),
          );
        }
      } finally {
        await roleSetup.query(
          "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
        );
        roleSetup.release();
      }
      await owner.query('SELECT luma_provision_cell_region($1)', ['AU']);
      await admin.query(
        `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(
        `GRANT luma_identity,luma_policies,luma_execution,luma_audit,luma_desk,luma_connectors TO "${login}"`,
      );
      url.username = login;
      url.password = password;
      runtimeUrl = url.toString();
      runtime = new Pool({ connectionString: runtimeUrl });
      app = await buildRuntimeApp({
        databaseUrl: runtimeUrl,
        secret: 'test-secret-with-at-least-32-characters',
        baseURL: origin,
        trustedOrigins: [origin],
      });
      app.get(
        '/v1/organizations/:organizationId/capture',
        { config: { access: { access: 'member' } } },
        async (request) => {
          contexts.set(request.id, request.tenantContext!);

          return { requestId: request.id };
        },
      );
      const a = await signup('alice');
      const b = await signup('bob');
      const m = await signup('member');
      const o = await signup('outsider');
      tenantId = await organization(a.cookie, 'tenant-a');
      await owner.query(
        "UPDATE organizations SET write_mode='writes_enabled' WHERE id=$1",
        [tenantId],
      );
      const tenantB = await organization(o.cookie, 'tenant-b');
      await owner.query(
        "UPDATE organizations SET write_mode='writes_enabled' WHERE id=$1",
        [tenantB],
      );
      for (const [user, role] of [
        [b, 'admin'],
        [m, 'member'],
      ] as const) {
        const id = randomUUID();
        await owner.query(
          'INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,$4,now())',
          [id, tenantId, user.id, role],
        );
        if (role === 'admin') bobMembership = id;
      }
      alice = await context(a.cookie, tenantId);
      bob = await context(b.cookie, tenantId);
      member = await context(m.cookie, tenantId);
      outsider = await context(o.cookie, tenantB);
      await owner.query(
        "CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$",
      );
      safety = startSafety();
    }, 30000);
    beforeEach(() => {
      execute.mockReset().mockResolvedValue({ evidenceRefs: [observationId] });
      verify.mockReset().mockImplementation(async () => ({
        outcome: 'passed',
        observationRefs: [observationId],
        observedAt: new Date().toISOString(),
        evaluatorVersion: 'fixture-1',
      }));
      checkPreconditions.mockReset().mockResolvedValue(true);
      resolve
        .mockReset()
        .mockImplementation(async (ctx, intent) =>
          ctx.tenantId === intent.tenantId &&
          intent.connectionId === connectionId
            ? adapter
            : null,
        );
    });
    afterAll(async () => {
      await safety?.close();
      await app?.close();
      await runtime?.end();
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.query(`DROP ROLE IF EXISTS "${login}"`);
      await admin.end();
    });

    it('renames a connection for managers only and audits both names', async () => {
      const connections = createInstalledConnections(
        createTenantDatabase(runtime),
        {
          refreshContext,
          verify: async (connection) => connection.permissions,
          activeKeyId: 'test',
          keys: new Map([['test', randomBytes(32)]]),
        },
      );
      const installed = await connections.install(alice, {
        label: 'Main warehouse',
        target: { kind: 'fixture' },
        permissions: ['inventory.available.reconcile'],
        credentials: { token: 'fixture' },
      });
      await expect(
        connections.rename(member, installed.id, installed.version, 'Other'),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        connections.rename(outsider, installed.id, installed.version, 'Other'),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        connections.rename(bob, installed.id, installed.version, '   '),
      ).rejects.toMatchObject({ statusCode: 422 });
      const renamed = await connections.rename(
        bob,
        installed.id,
        installed.version,
        '  North warehouse ',
      );
      expect(renamed).toMatchObject({
        label: 'North warehouse',
        status: installed.status,
        target: installed.target,
        version: installed.version + 1,
      });
      // A stale version means someone changed the connection since it was read.
      await expect(
        connections.rename(alice, installed.id, installed.version, 'Late'),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (
          await owner.query(
            "SELECT actor_id,before_value,after_value FROM connector_lifecycle_events WHERE tenant_id=$1 AND connection_id=$2 AND event='renamed'",
            [tenantId, installed.id],
          )
        ).rows,
      ).toEqual([
        {
          actor_id: bob.actor.id,
          before_value: { label: 'Main warehouse' },
          after_value: { label: 'North warehouse' },
        },
      ]);
    });

    it('isolates connection controls, audits owner changes and retains observed proposals after enabling writes', async () => {
      const connections = createInstalledConnections(
        createTenantDatabase(runtime),
        {
          refreshContext,
          verify: async (connection) => connection.permissions,
          activeKeyId: 'test',
          keys: new Map([['test', randomBytes(32)]]),
        },
      );
      const install = (label: string) =>
        connections.install(alice, {
          label,
          target: { kind: 'fixture' },
          permissions: ['inventory.available.reconcile'],
          credentials: { token: 'fixture' },
        });
      const first = await install('Observed');
      const second = await install('Enabled');
      for (const actor of [bob, member])
        await expect(
          connections.updateWriteMode(
            actor,
            first.id,
            first.version,
            'observe_only',
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        connections.updateWriteMode(
          outsider,
          first.id,
          first.version,
          'observe_only',
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      const restricted = await connections.updateWriteMode(
        alice,
        first.id,
        first.version,
        'observe_only',
      );
      resolve.mockResolvedValue(adapter);
      const observedAction = action({ connectionId: first.id });
      const observed = await safety.execution.execute(alice, observedAction);
      expect(observed).toMatchObject({
        state: 'not_executed',
        reason: 'observe_only',
      });
      expect(execute).not.toHaveBeenCalled();
      expect(checkPreconditions).not.toHaveBeenCalled();
      expect(
        await safety.execution.execute(
          alice,
          action({ connectionId: second.id }),
        ),
      ).toMatchObject({ state: 'succeeded' });
      expect(execute).toHaveBeenCalledTimes(1);
      const restored = await connections.updateWriteMode(
        alice,
        first.id,
        restricted.version,
        null,
      );
      expect(restored.writeMode).toBeNull();
      await safety.close();
      safety = startSafety();
      expect(await safety.execution.execute(alice, observedAction)).toEqual(
        observed,
      );
      expect(execute).toHaveBeenCalledTimes(1);
      const events = (
        await owner.query(
          "SELECT actor_id,before_value,after_value FROM connector_lifecycle_events WHERE tenant_id=$1 AND connection_id=$2 AND event='write_mode_changed' ORDER BY version",
          [tenantId, first.id],
        )
      ).rows;
      expect(events).toEqual([
        {
          actor_id: alice.actor.id,
          before_value: { writeMode: null },
          after_value: { writeMode: 'observe_only' },
        },
        {
          actor_id: alice.actor.id,
          before_value: { writeMode: 'observe_only' },
          after_value: { writeMode: null },
        },
      ]);
      expect(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2',
            [tenantId, observedAction.id],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    async function playbookFixture(
      facts = { diagnosisReady: true, methodMapped: true },
      age = 0,
      source = shippingMethodPlaybook,
    ) {
      const service = createAdmissionServices(
        runtimeUrl,
        { refreshContext },
        { resolve },
        { eligible: async () => true },
      );
      const playbooks = createResolutionPlaybooks(
        createTenantDatabase(runtime),
        { refreshContext },
        service,
      );
      const proposal = action({
        capability: 'orders.shipping-method.write',
        capabilityVersion: '0',
        target: { kind: 'order', id: randomUUID() },
        parameters: {},
        expectedPostcondition: { shippingMethodId: '8' },
        risk: 'high',
      });
      resolve.mockResolvedValue({
        ...adapter,
        capability: proposal.capability,
        version: '0',
        minimumRisk: 'high',
      });
      verify.mockImplementation(async () => ({
        outcome: 'passed',
        observationRefs: [observationId],
        observedAt: new Date().toISOString(),
        evaluatorVersion: 'shipping-method/1',
      }));
      const version = await playbooks.publish(alice, source);
      const activation = await playbooks.activate(alice, {
        id: randomUUID(),
        definitionId: version.definition.id,
        version: version.version,
        grants: {
          principalIds: [alice.actor.id],
          connectionIds: [connectionId],
          targetIds: [proposal.target.id],
        },
        policyVersion: 'v0.1',
      });
      const command = {
        activationId: activation.id,
        incidentId: randomUUID(),
        diagnosisRevision: 1,
        action: proposal,
        snapshot: {
          inputs: { shippingMethodId: '8' },
          evidence: {
            kind: 'workflow_failure',
            facts,
            observations: [
              {
                id: observationId,
                observedAt: new Date(Date.now() - age).toISOString(),
                source: 'pilot/1',
              },
            ],
          },
          provenance: {
            reference: 'LUMA-41 pilot evaluation',
            capturedAt: new Date().toISOString(),
          },
        },
      };
      const run = await playbooks.bind(alice, command);

      return { service, playbooks, version, activation, command, run };
    }

    async function approvePlaybook(
      f: Awaited<ReturnType<typeof playbookFixture>>,
    ) {
      const waiting = await f.playbooks.execute(alice, f.run.id);
      expect(waiting.state).toBe('awaiting_approval');
      expect(execute).not.toHaveBeenCalled();
      await f.service.policies.respond(
        bob,
        waiting.decisionId!,
        'approved',
        new Date(Date.now() + 60_000).toISOString(),
      );
    }

    it('persists the exact playbook, snapshot, grants and action; concurrent replay dispatches once', async () => {
      const f = await playbookFixture();
      try {
        await approvePlaybook(f);
        const results = await Promise.all([
          f.playbooks.execute(alice, f.run.id),
          f.playbooks.execute(alice, f.run.id),
        ]);
        expect(results.some((r) => r.state === 'verified')).toBe(true);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledWith(
          f.run.action,
          `v0:${f.run.id}`,
          expect.any(Function),
        );
        const restarted = createResolutionPlaybooks(
          createTenantDatabase(runtime),
          { refreshContext },
          f.service,
        );
        expect((await restarted.execute(alice, f.run.id)).state).toBe(
          'verified',
        );
        expect(await restarted.bind(alice, f.command)).toEqual(f.run);
        const history = await restarted.get(alice, f.run.id);
        expect(history.run.snapshot).toEqual(f.command.snapshot);
        expect(history.run.versionDigest).toBe(f.version.digest);
        expect(history.run.artifactDigest).toBe(f.activation.artifactDigest);
        expect(history.outcomes).toContainEqual(
          expect.objectContaining({
            state: 'verified',
            stepId: 'verify-correction',
            execution: expect.objectContaining({
              record: expect.objectContaining({
                attempt: expect.objectContaining({
                  verification: expect.objectContaining({
                    observationRefs: [observationId],
                  }),
                }),
              }),
            }),
          }),
        );
        expect(execute).toHaveBeenCalledTimes(1);
        const altered = structuredClone(shippingMethodPlaybook);
        altered.ir.verification.maxDurationSeconds = 1;
        await expect(restarted.publish(alice, altered)).rejects.toThrow(
          'immutable',
        );
        await expect(
          restarted.bind(alice, {
            ...f.command,
            snapshot: {
              ...f.command.snapshot,
              provenance: {
                ...f.command.snapshot.provenance,
                reference: 'changed',
              },
            },
          }),
        ).rejects.toThrow('immutable');
        await expect(restarted.get(outsider, f.run.id)).rejects.toThrow(
          'not found',
        );
        await expect(restarted.get(member, f.run.id)).rejects.toThrow();
        for (const table of [
          'playbook_definitions',
          'playbook_versions',
          'playbook_activations',
          'playbook_runs',
          'playbook_outcomes',
        ]) {
          await expect(
            createTenantDatabase(runtime).transaction(tenantId, (tx) =>
              tx.query(
                `UPDATE ${table} SET document=document WHERE tenant_id=$1`,
                [tenantId],
              ),
            ),
          ).rejects.toThrow('permission denied');
          await expect(
            createTenantDatabase(runtime).transaction(tenantId, (tx) =>
              tx.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]),
            ),
          ).rejects.toThrow('permission denied');
          const foreign = await createTenantDatabase(runtime).transaction(
            outsider.tenantId,
            (tx) =>
              tx.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [tenantId]),
          );
          expect(foreign.rows).toEqual([]);
        }
      } finally {
        await f.service.close();
      }
    });
    it.each([
      ['ineligible', { diagnosisReady: false, methodMapped: true }, 0],
      ['stale_evidence', { diagnosisReady: true, methodMapped: true }, 301_000],
    ] as const)(
      'escalates %s evidence without binding dispatch authority',
      async (reason, facts, age) => {
        const f = await playbookFixture(facts, age);
        try {
          expect(await f.playbooks.execute(alice, f.run.id)).toMatchObject({
            state: 'escalated',
            reason,
            stepId: 'eligible',
          });
          await expect(
            f.service.execution.execute(alice, {
              runId: f.run.id,
              stepId: 'correct-shipping-method',
            }),
          ).rejects.toThrow('not found');
          expect(execute).not.toHaveBeenCalled();
        } finally {
          await f.service.close();
        }
      },
    );
    it('records policy denial and rejects activation changes or revoked grants', async () => {
      const f = await playbookFixture();
      try {
        checkPreconditions.mockResolvedValue(false);
        expect(await f.playbooks.execute(alice, f.run.id)).toMatchObject({
          state: 'denied',
          reason: 'policy_denied',
        });
        await expect(
          f.playbooks.bind(alice, {
            ...f.command,
            action: {
              ...f.command.action,
              id: randomUUID(),
              target: { kind: 'order', id: randomUUID() },
            },
          }),
        ).rejects.toThrow('grants');
        await f.playbooks.revoke(alice, f.activation.id);
        await expect(
          f.service.execution.execute(alice, {
            runId: f.run.id,
            stepId: 'correct-shipping-method',
          }),
        ).rejects.toThrow('activated artifact');
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await f.service.close();
      }
    });
    it.each(['failed', 'inconclusive'] as const)(
      'escalates %s verification and never redispatches on recovery',
      async (outcome) => {
        const f = await playbookFixture();
        try {
          await approvePlaybook(f);
          verify.mockImplementation(async () => ({
            outcome,
            observationRefs: [observationId],
            observedAt: new Date().toISOString(),
            evaluatorVersion: 'shipping-method/1',
          }));
          expect((await f.playbooks.execute(alice, f.run.id)).state).toBe(
            'escalated',
          );
          expect((await f.playbooks.reconcile(alice, f.run.id)).state).toBe(
            'escalated',
          );
          expect(execute).toHaveBeenCalledTimes(1);
          expect(
            (await f.playbooks.get(alice, f.run.id)).outcomes.some(
              (o) =>
                o.execution?.record.attempt.verification?.outcome === outcome,
            ),
          ).toBe(true);
        } finally {
          await f.service.close();
        }
      },
    );
    it('enforces playbook grants even when admission is called directly', async () => {
      const f = await playbookFixture();
      try {
        const foreignAction = {
          ...f.run.action,
          id: randomUUID(),
          target: { kind: 'order', id: randomUUID() },
        };
        await f.service.provisioning.bind(alice, {
          runId: foreignAction.id,
          stepId: 'correct-shipping-method',
          tenantId,
          principalId: alice.actor.id,
          artifactId: `playbook:${f.activation.id}`,
          artifactVersion: f.version.version,
          artifactDigest: f.activation.artifactDigest,
          incidentId: f.run.incidentId,
          diagnosisRevision: 1,
          eligibilityValidUntil: f.run.action.preconditions.validUntil,
          action: foreignAction,
        });
        await expect(
          f.service.execution.execute(alice, {
            runId: foreignAction.id,
            stepId: 'correct-shipping-method',
          }),
        ).rejects.toThrow('activation grants');
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await f.service.close();
      }
    });
    it('rejects a successful receipt from a different verification evaluator', async () => {
      const f = await playbookFixture();
      try {
        await approvePlaybook(f);
        verify.mockImplementation(async () => ({
          outcome: 'passed',
          observationRefs: [observationId],
          observedAt: new Date().toISOString(),
          evaluatorVersion: 'other/1',
        }));
        expect(await f.playbooks.execute(alice, f.run.id)).toMatchObject({
          state: 'escalated',
          reason: 'verification_inconclusive',
        });
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        await f.service.close();
      }
    });
    it('publishes authored and round-tripped versions while rejecting changed digests', async () => {
      const f = await playbookFixture();
      try {
        const authored = definePlaybook(shippingMethodPlaybook);
        expect(await f.playbooks.publish(alice, authored)).toEqual(f.version);
        expect(
          await f.playbooks.publish(
            alice,
            parsePlaybookCode(printPlaybookCode(authored)),
          ),
        ).toEqual(f.version);
        const changed = structuredClone(authored);
        changed.ir.evidence.maxAgeSeconds = 10;
        await expect(f.playbooks.publish(alice, changed)).rejects.toThrow(
          'digest mismatch',
        );
      } finally {
        await f.service.close();
      }
    });
    it('does not grant admission when an ineligible run is rebound with changed evidence', async () => {
      const f = await playbookFixture({
        diagnosisReady: true,
        methodMapped: false,
      });
      try {
        const changed = structuredClone(f.command);
        changed.snapshot.evidence.facts.methodMapped = true;
        const results = await Promise.allSettled([
          f.playbooks.bind(alice, changed),
          f.playbooks.bind(alice, f.command),
        ]);
        expect(results[0]).toMatchObject({
          status: 'rejected',
          reason: expect.objectContaining({
            message: 'Playbook run is immutable',
          }),
        });
        expect(results[1].status).toBe('fulfilled');
        expect(
          await f.service.provisioning.step(
            alice,
            f.run.id,
            'correct-shipping-method',
          ),
        ).toBeNull();
        await expect(
          f.service.execution.execute(alice, {
            runId: f.run.id,
            stepId: 'correct-shipping-method',
          }),
        ).rejects.toThrow('not found');
        expect(
          (await f.playbooks.get(alice, f.run.id)).run.snapshot.evidence.facts
            .methodMapped,
        ).toBe(false);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await f.service.close();
      }
    });
    it('completes admission on replay after run persistence succeeds but admission binding fails', async () => {
      const f = await playbookFixture();
      try {
        const command = {
          ...f.command,
          action: { ...f.command.action, id: randomUUID() },
        };
        const binding = vi
          .spyOn(f.service.provisioning, 'bind')
          .mockRejectedValueOnce(new Error('temporary admission store outage'));
        await expect(f.playbooks.bind(alice, command)).rejects.toThrow(
          'temporary',
        );
        expect(
          (await f.playbooks.get(alice, command.action.id)).run.action,
        ).toEqual(command.action);
        expect(
          await f.service.provisioning.step(
            alice,
            command.action.id,
            'correct-shipping-method',
          ),
        ).toBeNull();
        await f.playbooks.bind(alice, command);
        expect(binding).toHaveBeenCalledTimes(2);
        expect(
          await f.service.provisioning.step(
            alice,
            command.action.id,
            'correct-shipping-method',
          ),
        ).not.toBeNull();
        binding.mockRestore();
      } finally {
        await f.service.close();
      }
    });
    it('rejects malformed incident references before persisting a run', async () => {
      const f = await playbookFixture();
      try {
        for (const invalid of [
          { incidentId: 'invalid' },
          { diagnosisRevision: 0 },
        ]) {
          const command = {
            ...f.command,
            ...invalid,
            action: { ...f.command.action, id: randomUUID() },
          };
          await expect(f.playbooks.bind(alice, command)).rejects.toThrow();
          await expect(
            f.playbooks.get(alice, command.action.id),
          ).rejects.toThrow('not found');
          expect(
            await f.service.provisioning.step(
              alice,
              command.action.id,
              'correct-shipping-method',
            ),
          ).toBeNull();
        }
      } finally {
        await f.service.close();
      }
    });
    it('retries a transient pre-dispatch failure without persisting terminal escalation', async () => {
      const f = await playbookFixture();
      try {
        resolve.mockRejectedValueOnce(
          new Error('temporary connector lookup outage'),
        );
        await expect(f.playbooks.execute(alice, f.run.id)).rejects.toThrow(
          'temporary',
        );
        expect((await f.playbooks.get(alice, f.run.id)).outcomes).toEqual([]);
        await approvePlaybook(f);
        expect((await f.playbooks.execute(alice, f.run.id)).state).toBe(
          'verified',
        );
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        await f.service.close();
      }
    });
    it.each(['during_preflight', 'direct_admission'] as const)(
      'enforces the pinned evidence deadline for %s',
      async (mode) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const source = structuredClone(shippingMethodPlaybook);
        source.definition.id = 'shipping-method-short-evidence';
        source.ir.evidence.maxAgeSeconds = 1;
        const f = await playbookFixture(undefined, 0, source);
        try {
          await approvePlaybook(f);
          const deadline =
            Date.parse(f.run.snapshot.evidence.observations[0]!.observedAt) +
            1000;
          const step = await f.service.provisioning.step(
            alice,
            f.run.id,
            'correct-shipping-method',
          );
          expect(step?.eligibilityValidUntil).toBe(
            new Date(deadline).toISOString(),
          );
          if (mode === 'during_preflight') {
            checkPreconditions.mockImplementationOnce(async () => {
              vi.setSystemTime(deadline + 1);

              return true;
            });
            expect(await f.playbooks.execute(alice, f.run.id)).toMatchObject({
              state: 'escalated',
              execution: {
                record: { attempt: { dispatch: 'not_dispatched' } },
              },
            });
          } else {
            vi.setSystemTime(deadline);
            await expect(
              f.service.execution.execute(alice, {
                runId: f.run.id,
                stepId: 'correct-shipping-method',
              }),
            ).rejects.toThrow('no longer eligible');
          }
          expect(execute).not.toHaveBeenCalled();
          await expect(
            f.service.provisioning.bind(alice, {
              ...step!,
              eligibilityValidUntil: new Date(deadline + 60_000).toISOString(),
            }),
          ).rejects.toThrow('already bound');
        } finally {
          vi.useRealTimers();
          await f.service.close();
        }
      },
    );
    it('recovers a lost provider response with fresh verification after evidence expiry', async () => {
      const f = await playbookFixture();
      try {
        await approvePlaybook(f);
        execute.mockRejectedValue(new Error('lost response'));
        verify.mockRejectedValue(new Error('read unavailable'));
        expect(await f.playbooks.execute(alice, f.run.id)).toMatchObject({
          state: 'escalated',
          reason: 'reconciliation_required',
        });
        const future = new Date(Date.now() + 301_000);
        verify.mockResolvedValue({
          outcome: 'passed',
          observationRefs: [observationId],
          observedAt: new Date().toISOString(),
          evaluatorVersion: 'shipping-method/1',
        });
        const recovered = createResolutionPlaybooks(
          createTenantDatabase(runtime),
          { refreshContext },
          f.service,
          () => future,
        );
        expect((await recovered.reconcile(alice, f.run.id)).state).toBe(
          'verified',
        );
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        await f.service.close();
      }
    });
    it('persists intent, policy and preparation before the effect; success requires verification', async () => {
      const proposal = action({
        proposedBy: {
          kind: 'user',
          id: alice.actor.id,
          initiatingUserId: alice.actor.initiatingUserId,
        },
      });
      const executor: EffectAdapter['executor'] = {
        kind: 'agent',
        id: 'trusted-executor',
        model: {
          provider: 'fixture',
          name: 'test',
          version: '1',
          promptVersion: '2',
          runId: randomUUID(),
        },
      };
      resolve.mockResolvedValue({ ...adapter, executor });
      execute.mockImplementation(async (intent, key) => {
        expect(key).toBe(`v0:${proposal.id}`);
        expect(intent).toEqual(proposal);
        const records = await owner.query(
          'SELECT document FROM executed_actions WHERE proposal_id=$1',
          [proposal.id],
        );
        expect(records.rows[0].document.state).toBe('prepared');
        expect(
          (await audit(proposal.id)).map((entry) => entry.eventType),
        ).toEqual(['policy.evaluated', 'execution.prepared']);

        return { evidenceRefs: [observationId] };
      });
      const result = await safety.execution.execute(alice, proposal);
      expect(result.state).toBe('succeeded');
      expect((await safety.execution.get(alice, proposal.id))?.state).toBe(
        'succeeded',
      );
      expect(await safety.execution.get(outsider, proposal.id)).toBeNull();
      expect(execute).toHaveBeenCalledTimes(1);
      if ('record' in result) {
        expect(result.record.intent.proposedBy).toEqual(proposal.proposedBy);
        expect(result.record.attempt.executor.model?.promptVersion).toBe('2');
        expect(result.record.attempt).toMatchObject({
          number: 1,
          mechanism: 'api',
          executor,
          verification: { outcome: 'passed' },
        });
      }
      expect(
        (await audit(proposal.id)).map((entry) => entry.eventType),
      ).toEqual([
        'policy.evaluated',
        'execution.prepared',
        'execution.completed',
      ]);
      expect(
        (await audit(proposal.id)).find(
          (entry) => entry.eventType === 'execution.prepared',
        ),
      ).toMatchObject({ proposedBy: proposal.proposedBy, executor });
      expect(execute).toHaveBeenCalledTimes(1);
    });
    it('rejects forged proposer provenance before persisting intent or audit', async () => {
      const model = {
        provider: 'fixture',
        name: 'forged',
        version: '1',
        promptVersion: '1',
        runId: randomUUID(),
      };
      const claims: ProposedAction['proposedBy'][] = [
        { kind: 'user', id: bob.actor.id },
        { kind: 'user', id: alice.actor.id, initiatingUserId: bob.actor.id },
        { kind: 'user', id: alice.actor.id, model },
        { kind: 'service', id: alice.actor.id },
        { kind: 'connector', id: alice.actor.id },
        {
          kind: 'agent',
          id: alice.actor.id,
          initiatingUserId: alice.actor.id,
          model,
        },
      ];
      for (const proposedBy of claims) {
        const proposal = action({ proposedBy });
        await expect(safety.execution.execute(alice, proposal)).rejects.toThrow(
          'Proposer must match the authenticated user',
        );
        expect(
          (
            await owner.query(
              'SELECT id FROM execution_intents WHERE tenant_id=$1 AND id=$2',
              [tenantId, proposal.id],
            )
          ).rowCount,
        ).toBe(0);
        expect(await audit(proposal.id)).toEqual([]);
      }
      expect(resolve).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
    it('keeps rejection binding when adapter risk is lowered or the response expires', async () => {
      const proposal = action();
      resolve.mockResolvedValue({ ...adapter, minimumRisk: 'high' });
      const waiting = await safety.execution.execute(alice, proposal);
      expect(waiting.state).toBe('approval_required');
      if (!('decision' in waiting)) throw new Error('Missing decision');
      const rejection = await safety.policies.respond(
        bob,
        waiting.decision.id,
        'rejected',
        new Date(Date.now() + 60_000).toISOString(),
      );
      resolve.mockResolvedValue(adapter);
      for (const expired of [false, true]) {
        if (expired)
          await owner.query(
            "UPDATE policy_approvals SET document=jsonb_set(document,'{expiresAt}',to_jsonb('2020-01-01T00:00:00.000Z'::text)) WHERE id=$1",
            [rejection.id],
          );
        const result = await safety.execution.execute(alice, proposal);
        expect(result).toMatchObject({
          state: 'denied',
          decision: { reason: 'approval_rejected' },
        });
      }
      expect(execute).not.toHaveBeenCalled();
      expect(
        (
          await owner.query(
            'SELECT id FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2',
            [tenantId, proposal.id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (await audit(proposal.id)).filter(
          (entry) => entry.details.reason === 'approval_rejected',
        ),
      ).toHaveLength(2);
      expect((await safety.execution.execute(alice, action())).state).toBe(
        'succeeded',
      );
    });
    it('denies missing permissions, unavailable capabilities, stale evidence and foreign tenants', async () => {
      expect(
        (
          await safety.execution.execute(
            member,
            action({ proposedBy: { kind: 'user', id: member.actor.id } }),
          )
        ).state,
      ).toBe('denied');
      expect(
        (
          await safety.execution.execute(
            alice,
            action({ connectionId: randomUUID() }),
          )
        ).state,
      ).toBe('denied');
      expect(
        (
          await safety.execution.execute(
            alice,
            action({ capabilityVersion: '2' }),
          )
        ).state,
      ).toBe('denied');
      expect(
        (
          await safety.execution.execute(
            alice,
            action({ expiresAt: '2020-01-01T00:00:00.000Z' }),
          )
        ).state,
      ).toBe('denied');
      checkPreconditions.mockResolvedValue(false);
      expect((await safety.execution.execute(alice, action())).state).toBe(
        'denied',
      );
      await expect(
        safety.execution.execute(outsider, action()),
      ).rejects.toThrow('Resource not found');
      await expect(
        safety.execution.execute({ ...alice } as TenantContext, {
          ...action(),
          risk: 'invalid',
        }),
      ).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    });
    it('requires a separate authorized approver and binds grants to immutable intent', async () => {
      const proposal = action({ risk: 'high' });
      const waiting = await safety.execution.execute(alice, proposal);
      expect(waiting.state).toBe('approval_required');
      if (!('decision' in waiting)) throw new Error('Missing decision');
      const expiry = new Date(Date.now() + 60_000).toISOString();
      await expect(
        safety.policies.respond(alice, waiting.decision.id, 'approved', expiry),
      ).rejects.toThrow('different approver');
      await expect(
        safety.policies.respond(
          member,
          waiting.decision.id,
          'approved',
          expiry,
        ),
      ).rejects.toThrow('Your role does not allow');
      await expect(
        safety.policies.respond(
          outsider,
          waiting.decision.id,
          'approved',
          expiry,
        ),
      ).rejects.toThrow('not found');
      const granted = await safety.policies.respond(
        bob,
        waiting.decision.id,
        'approved',
        expiry,
      );
      expect(granted.approverId).toBe(bob.actor.id);
      await expect(
        safety.execution.execute(alice, {
          ...proposal,
          parameters: { quantity: 4 },
        }),
      ).rejects.toThrow('conflicts');
      expect((await safety.execution.execute(alice, proposal)).state).toBe(
        'succeeded',
      );
      expect(
        (await audit(proposal.id)).some(
          (entry) => entry.eventType === 'approval.responded',
        ),
      ).toBe(true);
    });
    it('keeps the first approval response and enforces rejection', async () => {
      const proposal = action({ risk: 'medium' });
      const waiting = await safety.execution.execute(alice, proposal);
      if (!('decision' in waiting)) throw new Error('Missing decision');
      const expiry = new Date(Date.now() + 60_000).toISOString();
      await safety.policies.respond(
        bob,
        waiting.decision.id,
        'rejected',
        expiry,
      );
      const replay = await safety.policies.respond(
        bob,
        waiting.decision.id,
        'approved',
        expiry,
      );
      expect(replay.outcome).toBe('rejected');
      expect((await safety.execution.execute(alice, proposal)).state).toBe(
        'denied',
      );
      expect(execute).not.toHaveBeenCalled();
    });
    it('runs Temporal recovery against the persisted execution service without a second effect', async () => {
      const env = await TestWorkflowEnvironment.createLocal();
      const proposal = action();
      const incidentId = randomUUID();
      const diagnosis = {
        exceptionId: incidentId,
        revision: 1,
        status: 'ready',
        superseded: false,
        detectorDecision: { decision: 'detect' },
        provenance: {
          validUntil: proposal.expiresAt,
          reread: { retryAfter: null },
        },
      };
      const businessVerify = vi.fn().mockResolvedValue(true);
      const admissionSafety = createAdmissionServices(
        runtimeUrl,
        { refreshContext },
        { resolve },
        { eligible: async () => true },
      );
      await admissionSafety.provisioning.activate(alice, {
        id: 'exception-resolution',
        version: '1',
        generation: { kind: 'manual', reference: 'temporal-test' },
        steps: {
          execute: {
            capability: 'stock.correct',
            capabilityVersion: '1',
            targetKind: 'sku',
            minimumRisk: 'low',
          },
        },
      });
      const processRuntime = createExceptionWorkflowRuntime(
        {
          address: env.address,
          namespace: 'default',
          taskQueue: randomUUID(),
          dataRegion: 'AU',
        },
        {
          refreshContext,
          resolveWorkflowContext: async (userId, organizationId) =>
            context(cookies.get(userId)!, organizationId),
        },
        {
          exceptions: {
            get: vi
              .fn()
              .mockResolvedValue({ id: incidentId, state: 'detected' }),
            ingest: vi.fn(),
            list: vi.fn(),
            evidence: vi.fn(),
            resolve: vi.fn(),
            verify: businessVerify,
          },
          diagnoses: {
            get: vi.fn().mockResolvedValue(diagnosis),
            run: vi.fn().mockResolvedValue(diagnosis),
            history: vi.fn(),
          },
        },
        admissionSafety,
        {
          loadDetection: vi.fn(),
          proposals: {
            prepare: async () => proposal,
            get: async () => ({
              exceptionId: incidentId,
              revision: 1,
              action: proposal,
            }),
          },
        },
      );
      const client = await processRuntime.createClient();
      const worker = await processRuntime.createWorker();
      const running = worker.run();
      try {
        execute.mockRejectedValueOnce(
          new Error('provider committed before connection loss'),
        );
        const source = { kind: 'incident' as const, id: incidentId };
        const started = await client.start(alice, source);
        expect(await client.start(alice, source)).toEqual(started);
        await vi.waitFor(
          async () =>
            expect(await client.progress(alice, source)).toMatchObject({
              phase: 'resolved',
            }),
          { timeout: 15_000 },
        );
        expect(execute).toHaveBeenCalledTimes(1);
        expect(verify).toHaveBeenCalledTimes(1);
        expect(businessVerify).toHaveBeenCalledTimes(1);
        expect((await safety.execution.get(alice, proposal.id))?.state).toBe(
          'succeeded',
        );
        expect(
          (await audit(proposal.id)).map((entry) => entry.eventType),
        ).toContain('execution.reconciled');
      } finally {
        await admissionSafety.close();
        worker.shutdown();
        await running;
        await worker.close();
        await client.close();
        await env.teardown();
      }
    }, 30_000);
    it('withholds a mutation when authority changes during transport preparation and never redispatches it', async () => {
      const proposal = action({
        proposedBy: { kind: 'user', id: bob.actor.id },
      });
      let writes = 0;
      execute.mockImplementationOnce(async (_intent, _key, beforeDispatch) => {
        await owner.query("UPDATE memberships SET role='member' WHERE id=$1", [
          bobMembership,
        ]);
        await beforeDispatch?.();
        writes++;

        return { evidenceRefs: [observationId] };
      });
      try {
        const result = await safety.execution.execute(bob, proposal);
        expect(result).toMatchObject({
          state: 'failed',
          record: { attempt: { dispatch: 'not_dispatched' } },
        });
        expect(writes).toBe(0);
        expect(verify).not.toHaveBeenCalled();
      } finally {
        await owner.query("UPDATE memberships SET role='admin' WHERE id=$1", [
          bobMembership,
        ]);
      }
      await safety.execution.execute(bob, proposal);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(writes).toBe(0);
    });
    it('rechecks revoked roles instead of trusting the original context', async () => {
      await owner.query("UPDATE memberships SET role='member' WHERE id=$1", [
        bobMembership,
      ]);
      try {
        await expect(safety.execution.get(bob, randomUUID())).rejects.toThrow(
          'Your role does not allow',
        );
        expect(
          (
            await safety.execution.execute(
              bob,
              action({ proposedBy: { kind: 'user', id: bob.actor.id } }),
            )
          ).state,
        ).toBe('denied');
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await owner.query("UPDATE memberships SET role='admin' WHERE id=$1", [
          bobMembership,
        ]);
      }
    });
    it('deduplicates concurrent audit appends without accepting conflicting evidence', async () => {
      const log = createAuditLog(createTenantDatabase(runtime));
      for (let round = 0; round < 8; round++) {
        const entry: AuditEntry = {
          id: randomUUID(),
          tenantId,
          eventKey: randomUUID(),
          proposalId: randomUUID(),
          eventType: 'execution.prepared',
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          actor: { kind: 'user', id: alice.actor.id },
          correlationId: randomUUID(),
          actionHash: 'fixture',
          evidenceRefs: [],
          details: {},
        };
        const results = await Promise.allSettled(
          Array.from({ length: 16 }, () => log.append(entry)),
        );
        expect(results).toEqual(
          Array.from({ length: 16 }, () => ({
            status: 'fulfilled',
            value: undefined,
          })),
        );
        expect(await log.list(tenantId, entry.proposalId)).toEqual([entry]);
        for (const conflict of [
          { ...entry, details: { outcome: 'changed' } },
          { ...entry, id: randomUUID() },
          { ...entry, eventKey: randomUUID() },
          { ...entry, tenantId: outsider.tenantId },
        ]) {
          await expect(log.append(conflict)).rejects.toThrow(
            'conflicts with existing evidence',
          );
        }
        expect(await log.list(tenantId, entry.proposalId)).toEqual([entry]);
        expect(await log.list(outsider.tenantId, entry.proposalId)).toEqual([]);
      }
    });
    it('serializes concurrent delivery, survives restart and rejects conflicting intent', async () => {
      const proposal = action();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          safety.execution.execute(alice, proposal),
        ),
      );
      expect(results.some((result) => result.state === 'succeeded')).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      await safety.close();
      safety = startSafety();
      expect((await safety.execution.execute(alice, proposal)).state).toBe(
        'succeeded',
      );
      expect(execute).toHaveBeenCalledTimes(1);
      await expect(
        safety.execution.execute(alice, {
          ...proposal,
          parameters: { quantity: 5 },
        }),
      ).rejects.toThrow('conflicts');
    });
    it('persists pending, failed and concurrent verification attempts without leaking errors', async () => {
      const proposal = action();
      execute.mockRejectedValue(
        new ConnectorError({
          code: 'timeout',
          effect: 'unknown',
          retry: 'reconcile',
          providerRequestId: 'request-timeout-43',
        }),
      );
      await safety.execution.execute(alice, proposal);
      let started!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      verify.mockImplementationOnce(async () => {
        started();
        await gate;
        throw new Error('secret-provider-response');
      });
      const failed = safety.execution.reconcile(alice, proposal.id);
      const failureAssertion = expect(failed).rejects.toThrow(
        'secret-provider-response',
      );
      await waiting;
      const entries = async () =>
        (
          await owner.query(
            'SELECT document FROM execution_verifications WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY created_at,id,phase DESC',
            [tenantId, proposal.id],
          )
        ).rows.map((row) => row.document);
      try {
        expect(await entries()).toMatchObject([
          { phase: 'pending', actorId: alice.actor.id },
        ]);
      } finally {
        release();
      }
      await failureAssertion;
      expect(await entries()).toMatchObject([
        { phase: 'pending' },
        {
          phase: 'completed',
          failure: { code: 'internal', phase: 'verification' },
        },
      ]);
      const failures = (
        await owner.query(
          'SELECT document FROM execution_failures WHERE tenant_id=$1 AND proposal_id=$2',
          [tenantId, proposal.id],
        )
      ).rows.map((row) => row.document);
      expect(failures).toMatchObject([
        {
          code: 'timeout',
          retry: 'reconcile',
          providerRequestId: 'request-timeout-43',
        },
      ]);
      expect(JSON.stringify(await entries())).not.toContain(
        'secret-provider-response',
      );
      await safety.close();
      safety = startSafety();
      let observed = 0;
      let bothStarted!: () => void;
      const together = new Promise<void>((resolve) => {
        bothStarted = resolve;
      });
      verify.mockImplementation(async () => {
        if (++observed === 2) bothStarted();
        await together;

        return {
          outcome: 'passed',
          observationRefs: [observationId],
          observedAt: new Date().toISOString(),
          evaluatorVersion: 'fixture',
        };
      });
      await Promise.all([
        safety.execution.reconcile(alice, proposal.id),
        safety.execution.reconcile(alice, proposal.id),
      ]);
      expect(
        (await entries()).filter((row) => row.phase === 'completed'),
      ).toHaveLength(3);
      expect(execute).toHaveBeenCalledTimes(1);
      await expect(
        runtime.query('UPDATE execution_verifications SET document=document'),
      ).rejects.toThrow('permission denied');
      const isolated = await runtime.connect();
      try {
        await isolated.query('BEGIN');
        await isolated.query("SELECT set_config('app.tenant_id',$1,true)", [
          outsider.tenantId,
        ]);
        expect(
          (await isolated.query('SELECT * FROM execution_verifications'))
            .rowCount,
        ).toBe(0);
        await isolated.query('ROLLBACK');
      } finally {
        isolated.release();
      }
    });
    it('does not retry ambiguous effects; reconciliation only reads authoritative state', async () => {
      const proposal = action();
      execute.mockRejectedValue(
        new Error('timeout containing secret-provider-payload'),
      );
      expect((await safety.execution.execute(alice, proposal)).state).toBe(
        'reconciliation_required',
      );
      await safety.close();
      safety = startSafety();
      expect((await safety.execution.execute(alice, proposal)).state).toBe(
        'reconciliation_required',
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(await audit(proposal.id))).not.toContain(
        'secret-provider-payload',
      );
      expect((await safety.execution.reconcile(alice, proposal.id)).state).toBe(
        'succeeded',
      );
      expect(execute).toHaveBeenCalledTimes(1);
    });
    it.each(['prepared', 'unknown'] as const)(
      'reconciles legacy %s attempts using their stored executor binding',
      async (state) => {
        const proposal = action();
        execute.mockRejectedValue(new Error('lost response'));
        await safety.execution.execute(alice, proposal);
        // Recreate the document shape persisted before dispatch identity was introduced.
        await owner.query('ALTER TABLE executed_actions DISABLE TRIGGER USER');
        try {
          await owner.query(
            `UPDATE executed_actions SET state=$2, document=jsonb_set(
              document #- '{attempt,dispatch}' #- '{attempt,businessOutcome}',
              '{state}', to_jsonb($2::text)) WHERE proposal_id=$1`,
            [proposal.id, state],
          );
        } finally {
          await owner.query('ALTER TABLE executed_actions ENABLE TRIGGER USER');
        }
        const current = { ...adapter, dispatchIdentity: 'provider/1' };
        resolve.mockResolvedValue({
          ...current,
          mechanism: 'deterministic_browser',
        });
        await expect(
          safety.execution.reconcile(alice, proposal.id),
        ).rejects.toThrow('Capability unavailable');
        resolve.mockResolvedValue({
          ...current,
          executor: { kind: 'connector', id: 'different' },
        });
        await expect(
          safety.execution.reconcile(alice, proposal.id),
        ).rejects.toThrow('Capability unavailable');
        expect(verify).not.toHaveBeenCalled();
        resolve.mockResolvedValue(current);
        expect(
          (await safety.execution.reconcile(alice, proposal.id)).state,
        ).toBe('succeeded');
        expect(execute).toHaveBeenCalledTimes(1);
        expect(verify).toHaveBeenCalledTimes(1);
      },
    );
    it.each(['failed', 'inconclusive'] as const)(
      'preserves an in-flight completion after %s reconciliation',
      async (outcome) => {
        const proposal = action();
        let notifyStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          notifyStarted = resolve;
        });
        let release!: (
          value: Awaited<ReturnType<EffectAdapter['execute']>>,
        ) => void;
        const response = new Promise<
          Awaited<ReturnType<EffectAdapter['execute']>>
        >((resolve) => {
          release = resolve;
        });
        execute.mockImplementation(async () => {
          notifyStarted();

          return response;
        });
        verify.mockImplementationOnce(async () => ({
          outcome,
          observationRefs: [observationId],
          observedAt: new Date().toISOString(),
          evaluatorVersion: 'fixture-1',
        }));
        const pending = safety.execution.execute(alice, proposal);
        await started;
        try {
          expect(
            await safety.execution.reconcile(alice, proposal.id),
          ).toMatchObject({
            state: 'reconciliation_required',
            record: {
              state: 'prepared',
              attempt: { verification: { outcome } },
            },
          });
          expect((await safety.execution.execute(alice, proposal)).state).toBe(
            'reconciliation_required',
          );
        } finally {
          release({
            evidenceRefs: [observationId],
            providerRequestId: 'live-request',
          });
        }
        expect(await pending).toMatchObject({
          state: 'succeeded',
          record: {
            attempt: {
              dispatch: 'dispatched',
              providerRequestId: 'live-request',
              verification: { outcome: 'passed' },
            },
          },
        });
        expect(execute).toHaveBeenCalledTimes(1);
        const events = await audit(proposal.id);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              eventType: 'execution.reconciled',
              details: expect.objectContaining({ verification: outcome }),
            }),
            expect.objectContaining({
              eventType: 'execution.completed',
              details: expect.objectContaining({
                providerRequestId: 'live-request',
              }),
            }),
          ]),
        );
      },
    );
    it('does not equate an accepted request with verified success', async () => {
      verify.mockImplementation(async () => ({
        outcome: 'failed',
        observationRefs: [observationId],
        observedAt: new Date().toISOString(),
        evaluatorVersion: 'fixture-1',
      }));
      expect((await safety.execution.execute(alice, action())).state).toBe(
        'failed',
      );
      verify.mockResolvedValue({
        outcome: 'passed',
        observationRefs: [],
        observedAt: new Date().toISOString(),
        evaluatorVersion: 'fixture-1',
      });
      expect((await safety.execution.execute(alice, action())).state).toBe(
        'reconciliation_required',
      );
    });
    it('fails closed when audit is unavailable and recovers durable evidence', async () => {
      const proposal = action();
      await owner.query(
        'CREATE TRIGGER reject_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION reject_audit()',
      );
      try {
        await expect(safety.execution.execute(alice, proposal)).rejects.toThrow(
          'audit unavailable',
        );
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await owner.query('DROP TRIGGER reject_audit ON audit_entries');
      }
      expect((await safety.execution.execute(alice, proposal)).state).toBe(
        'succeeded',
      );
      expect(
        (
          await owner.query(
            'SELECT id FROM policy_outbox WHERE delivered_at IS NULL',
          )
        ).rowCount,
      ).toBe(0);
    });
    it('preserves completion in the outbox if audit delivery fails after an effect', async () => {
      const proposal = action();
      execute.mockImplementation(async () => {
        await owner.query(
          'CREATE TRIGGER reject_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION reject_audit()',
        );

        return { evidenceRefs: [observationId] };
      });
      try {
        await expect(safety.execution.execute(alice, proposal)).rejects.toThrow(
          'audit unavailable',
        );
      } finally {
        await owner.query('DROP TRIGGER reject_audit ON audit_entries');
      }
      await safety.close();
      safety = startSafety();
      expect((await safety.execution.execute(alice, proposal)).state).toBe(
        'succeeded',
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(
        (await audit(proposal.id)).some(
          (entry) => entry.eventType === 'execution.completed',
        ),
      ).toBe(true);
    });
    it('requires approval for connector risk even when a proposal claims low risk', async () => {
      resolve.mockResolvedValue({ ...adapter, minimumRisk: 'high' });
      expect((await safety.execution.execute(alice, action())).state).toBe(
        'approval_required',
      );
      expect(execute).not.toHaveBeenCalled();
    });
    it('rejects expired approval grants and stale verification observations', async () => {
      const proposal = action({ risk: 'high' });
      const waiting = await safety.execution.execute(alice, proposal);
      if (!('decision' in waiting)) throw new Error('Missing decision');
      const expired = {
        decisionId: waiting.decision.id,
        id: randomUUID(),
        tenantId,
        proposalId: proposal.id,
        actionHash: waiting.decision.actionHash,
        policyVersion: waiting.decision.policyVersion,
        requesterId: alice.actor.id,
        approverId: bob.actor.id,
        outcome: 'approved',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
        correlationId: randomUUID(),
      };
      await owner.query(
        'INSERT INTO policy_approvals(id,tenant_id,proposal_id,action_hash,policy_version,document) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          expired.id,
          tenantId,
          proposal.id,
          expired.actionHash,
          expired.policyVersion,
          expired,
        ],
      );
      expect((await safety.execution.execute(alice, proposal)).state).toBe(
        'approval_required',
      );
      expect(execute).not.toHaveBeenCalled();
      verify.mockResolvedValue({
        outcome: 'passed',
        observationRefs: [observationId],
        evaluatorVersion: 'fixture-1',
        observedAt: '2020-01-01T00:00:00.000Z',
      });
      expect((await safety.execution.execute(alice, action())).state).toBe(
        'reconciliation_required',
      );
    });
    it('leaves an interrupted prepared attempt blocked instead of resending it', async () => {
      const proposal = action();
      await owner.query(
        "CREATE FUNCTION reject_prepared_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.document->>'eventType' = 'execution.prepared' THEN RAISE EXCEPTION 'preparation audit unavailable'; END IF; RETURN NEW; END $$",
      );
      await owner.query(
        'CREATE TRIGGER reject_prepared_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION reject_prepared_audit()',
      );
      try {
        await expect(safety.execution.execute(alice, proposal)).rejects.toThrow(
          'preparation audit unavailable',
        );
      } finally {
        await owner.query(
          'DROP TRIGGER reject_prepared_audit ON audit_entries',
        );
      }
      expect(execute).not.toHaveBeenCalled();
      await safety.close();
      safety = startSafety();
      expect((await safety.execution.execute(alice, proposal)).state).toBe(
        'reconciliation_required',
      );
      verify.mockImplementation(async () => ({
        outcome: 'inconclusive',
        observationRefs: [observationId],
        evaluatorVersion: 'fixture-1',
        observedAt: new Date().toISOString(),
      }));
      expect((await safety.execution.reconcile(alice, proposal.id)).state).toBe(
        'reconciliation_required',
      );
      expect(execute).not.toHaveBeenCalled();
    });
    it('reconciles after the effect commits but completion persistence fails', async () => {
      const proposal = action();
      await owner.query(
        "CREATE FUNCTION reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'completion unavailable'; END $$",
      );
      await owner.query(
        'CREATE TRIGGER reject_completion BEFORE UPDATE ON executed_actions FOR EACH ROW EXECUTE FUNCTION reject_completion()',
      );
      try {
        await expect(safety.execution.execute(alice, proposal)).rejects.toThrow(
          'completion unavailable',
        );
      } finally {
        await owner.query('DROP TRIGGER reject_completion ON executed_actions');
      }
      expect(execute).toHaveBeenCalledTimes(1);
      await safety.close();
      safety = startSafety();
      expect((await safety.execution.execute(alice, proposal)).state).toBe(
        'reconciliation_required',
      );
      expect((await safety.execution.reconcile(alice, proposal.id)).state).toBe(
        'succeeded',
      );
      expect(execute).toHaveBeenCalledTimes(1);
    });
    it('canonicalizes object keys and scopes the same proposal ID to its tenant', async () => {
      const proposal = action({ parameters: { quantity: 3, unit: 'each' } });
      expect((await safety.execution.execute(alice, proposal)).state).toBe(
        'succeeded',
      );
      expect(
        (
          await safety.execution.execute(alice, {
            ...proposal,
            parameters: { unit: 'each', quantity: 3 },
          })
        ).state,
      ).toBe('succeeded');
      expect(
        (
          await safety.execution.execute(outsider, {
            ...proposal,
            tenantId: outsider.tenantId,
            proposedBy: { kind: 'user', id: outsider.actor.id },
          })
        ).state,
      ).toBe('succeeded');
      expect(execute).toHaveBeenCalledTimes(2);
    });
    it('enforces RLS, append-only privileges and immutable finalized attempts', async () => {
      for (const table of [
        'policy_decisions',
        'policy_approvals',
        'executed_actions',
        'execution_outbox',
        'audit_entries',
      ]) {
        expect((await runtime.query(`SELECT * FROM ${table}`)).rows).toEqual(
          [],
        );
        await expect(runtime.query(`DELETE FROM ${table}`)).rejects.toThrow(
          'permission denied',
        );
        await expect(runtime.query(`TRUNCATE ${table}`)).rejects.toThrow(
          'permission denied',
        );
      }
      await expect(
        runtime.query("UPDATE audit_entries SET document='{}'"),
      ).rejects.toThrow('permission denied');
      const proposal = action();
      await safety.execution.execute(alice, proposal);
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [
          outsider.tenantId,
        ]);
        expect(
          (
            await client.query(
              'SELECT id FROM executed_actions WHERE proposal_id=$1',
              [proposal.id],
            )
          ).rows,
        ).toEqual([]);
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [
          tenantId,
        ]);
        await expect(
          client.query(
            "UPDATE executed_actions SET state='unknown',document=jsonb_set(document,'{state}','\"unknown\"') WHERE proposal_id=$1",
            [proposal.id],
          ),
        ).rejects.toThrow('immutable');
        await client.query('ROLLBACK');
        expect(
          (await client.query('SELECT * FROM audit_entries')).rows,
        ).toEqual([]);
      } finally {
        client.release();
      }
    });
  },
);
