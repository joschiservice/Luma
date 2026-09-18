import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
import {
  buildRuntimeApp,
  createSafetyServices,
  createExceptionWorkflowRuntime,
} from './app.js';
import { TestWorkflowEnvironment } from '@temporalio/testing';
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
    let app: ReturnType<typeof buildRuntimeApp>;
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
          password: 'long-test-password',
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const raw = response.headers['set-cookie'];
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
        for (const name of [
          '0001_identity.sql',
          '0002_policy_execution_audit.sql',
        ]) {
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
      await admin.query(
        `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(
        `GRANT luma_identity,luma_policies,luma_execution,luma_audit TO "${login}"`,
      );
      url.username = login;
      url.password = password;
      runtimeUrl = url.toString();
      runtime = new Pool({ connectionString: runtimeUrl });
      app = buildRuntimeApp({
        databaseUrl: runtimeUrl,
        secret: 'test-secret-with-at-least-32-characters',
        baseURL: origin,
        trustedOrigins: [origin],
      });
      app.get('/v1/organizations/:organizationId/capture', async (request) => {
        contexts.set(request.id, request.tenantContext!);
        return { requestId: request.id };
      });
      const a = await signup('alice');
      const b = await signup('bob');
      const m = await signup('member');
      const o = await signup('outsider');
      tenantId = await organization(a.cookie, 'tenant-a');
      const tenantB = await organization(o.cookie, 'tenant-b');
      for (const [user, role] of [
        [b, 'admin'],
        [m, 'member'],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/organizations/${tenantId}/members`,
          headers: { cookie: a.cookie, origin },
          payload: { userId: user.id, role },
        });
        expect(response.statusCode).toBe(201);
        if (role === 'admin') bobMembership = response.json().id;
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
      ).rejects.toThrow('Insufficient');
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
      const processRuntime = createExceptionWorkflowRuntime(
        {
          address: env.address,
          namespace: 'default',
          taskQueue: randomUUID(),
          dataRegion: 'EU',
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
        safety,
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
        worker.shutdown();
        await running;
        await worker.close();
        await client.close();
        await env.teardown();
      }
    }, 30_000);
    it('rechecks revoked roles instead of trusting the original context', async () => {
      await owner.query("UPDATE memberships SET role='member' WHERE id=$1", [
        bobMembership,
      ]);
      try {
        await expect(safety.execution.get(bob, randomUUID())).rejects.toThrow(
          'Insufficient organization role',
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
