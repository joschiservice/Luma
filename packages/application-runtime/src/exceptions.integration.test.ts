import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import {
  caseDetailSchema,
  caseQuerySchema,
  decisionQuerySchema,
} from '@luma/api-contract';
import { createApiClient } from '@luma/api-contract/client';
import {
  buildApp,
  createDeskServices,
  createDetectionServices,
  createResolutionPlaybooks,
  createSafetyServices as createAdmittedSafety,
} from '@luma/application-runtime';
import type { CapabilityReader } from '@luma/connections';
import { createConnectionCoverage } from '@luma/connections/composition';
import type {
  DetectionRequest,
  Evidence,
  Incident,
  VerificationEvaluator,
  VerificationResult,
} from '@luma/exceptions';
import { defaultConfiguration } from '@luma/exceptions';
import {
  caseDecisionQuery,
  createCases,
  parseInput,
} from '@luma/exceptions/composition';
import type { IdentityService } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import type { ModelGateway } from '@luma/platform';
import { createTenantDatabase } from '@luma/platform/composition';
import { createDecisionQueue } from '@luma/read-models/composition';
import { shippingMethodPlaybook } from '@luma/resolution';
import {
  createOperationsOverview,
  createResolutionImprovementDiscovery,
  createResolutionLearning,
  createShadowEvaluations,
} from '@luma/resolution/composition';
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

import corpus from '../../exceptions/fixtures/exceptions-v0.json' with { type: 'json' };
import { createActiveDiagnosisRereader } from './composition/active-diagnosis.js';
import { detectionFixtures } from './test-support/detection-fixtures.js';
import { createSafetyFixture as createSafetyServices } from './test-support/safety-fixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('exception detection on PostgreSQL', () => {
  const name = `exceptions_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  let owner: Pool;
  let runtime: Pool;
  let services: ReturnType<typeof createDetectionServices>;
  let now = new Date(corpus.now);
  let runtimeUrl: string;
  const evaluate = vi.fn<VerificationEvaluator['evaluate']>();
  const tenantId = randomUUID(),
    otherTenant = randomUUID(),
    connectionId = randomUUID();

  function context(id: string = tenantId) {
    return makeTenantContext(
      { userId: 'operator', sessionId: 'session' },
      {
        id,
        name: 'Fixture',
        slug: 'fixture',
        dataRegion: 'EU',
        status: 'active',
      },
      builtInMembership(
        { id: 'membership', organizationId: id, userId: 'operator' },
        'owner',
      ),
      randomUUID(),
    );
  }

  function request(event = 'event-1', tenant = tenantId): DetectionRequest {
    const evidence: Evidence = {
      key: event,
      tenantId: tenant,
      connectionId,
      observedAt: corpus.now,
      sourceUpdatedAt: null,
      adapterVersion: 'fixture-v1',
      schemaVersion: 1,
      source: null,
      facts: { errorCode: 'authentication' },
    };

    return {
      key: event,
      input: parseInput('sync_failure', {
        ...corpus.bases.sync_failure,
        tenantId: tenant,
        evidenceTenantId: tenant,
        subjectId: connectionId,
        connectionId,
        evidenceRefs: [event],
      }),
      configuration: structuredClone(defaultConfiguration),
      evidence: [evidence],
    };
  }

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    owner = new Pool({ connectionString: url.toString() });
    const setup = await admin.connect();
    try {
      await setup.query(
        "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
      );
      for (const file of (
        await readdir(new URL('../migrations/', import.meta.url))
      ).sort()) {
        if (file.endsWith('.sql'))
          await owner.query(
            await readFile(
              new URL(`../migrations/${file}`, import.meta.url),
              'utf8',
            ),
          );
      }
    } finally {
      await setup.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
      setup.release();
    }
    // This fixture exercises enabled execution independently of identity provisioning.
    for (const id of [tenantId, otherTenant])
      await owner.query(
        "INSERT INTO organizations(id,name,slug,created_at,write_mode) VALUES($1::uuid,'Fixture',$1::uuid::text,now(),'writes_enabled')",
        [id],
      );
    // Policy reads real membership counts even though this fixture mocks principal refresh.
    for (const name of ['Requester', 'Approver']) {
      const userId = randomUUID();
      await owner.query(
        'INSERT INTO users(id,name,email,created_at,updated_at) VALUES($1,$2,$3,now(),now())',
        [userId, name, `${userId}@example.test`],
      );
      await owner.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",
        [randomUUID(), tenantId, userId],
      );
    }
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(
      `GRANT luma_exceptions,luma_case_reader,luma_desk,luma_execution TO "${name}"`,
    );
    url.username = name;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString() });
    runtimeUrl = url.toString();
    services = createDetectionServices(runtimeUrl, () => now, {
      version: 'fixture-postcondition-v1',
      evaluate,
    });
  });
  beforeEach(async () => {
    await owner.query(
      'TRUNCATE case_commands,case_proposals,execution_outbox,executed_actions,execution_intents,policy_outbox,policy_approvals,policy_decisions,audit_entries CASCADE',
    );
    now = new Date(corpus.now);
    evaluate.mockReset();
    await owner.query(
      'TRUNCATE exception_outbox,exception_evaluations,exception_evidence,exceptions,exception_inputs,exception_sources,exception_configurations,exception_uncertainty CASCADE',
    );
  });
  afterAll(async () => {
    await services?.close();
    await runtime?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.end();
  });

  it('publishes a scoped investigation as a new retained revision without closing a case or repeating the experiment', async () => {
    const initial = request('active-investigation');
    if (initial.input.exceptionClass !== 'sync_failure')
      throw new Error('Invalid fixture');
    initial.input.facts.errorCode = 'transient';
    initial.input.facts.retryExhausted = true;
    initial.input.facts.active = true;
    initial.input.facts.scanComplete = false;
    const incident = (await services.exceptions.ingest(context(), initial))
      .incident;
    if (!incident) throw new Error('Fixture did not open an incident');
    const db = createTenantDatabase(runtime);
    const read = vi.fn<CapabilityReader['read']>().mockResolvedValue({
      ok: true,
      value: { items: [], nextCursor: null, completeness: 'complete' },
    });
    const rereader = createActiveDiagnosisRereader({
      database: db,
      reader: {
        read,
        discover: async () => [
          {
            capability: 'inventory.read',
            version: '0',
            minimumRisk: 'low',
            idempotency: 'none',
            retry: { maxAttempts: 1, initialDelayMs: 0 },
          },
        ],
      },
      identity: { refreshContext: async (acting) => acting },
      enabled: async () => true,
      now: () => now,
    });
    if (!rereader) throw new Error('Missing active adapter');
    const active = createDetectionServices(db, () => now, undefined, {
      rereader,
    });
    const investigated = await active.diagnoses.run(context(), incident.id);
    expect(read).toHaveBeenCalledTimes(1);
    expect(investigated?.provenance.reread.status).toBe('completed');
    expect(investigated?.revision).toBe(2);
    expect(read).toHaveBeenCalledTimes(1);
    const diagnosis = await active.diagnoses.run(context(), incident.id);
    expect(diagnosis?.status).toBe('ready');
    expect(diagnosis?.provenance.reread.status).toBe('completed');
    expect(
      diagnosis?.facts.some(
        (finding) =>
          finding.code === 'persistent_read_failure_hypothesis_contradicted',
      ),
    ).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      (await active.exceptions.get(context(), incident.id))?.state,
    ).not.toBe('resolved');
    expect(
      (await active.diagnoses.investigationBudget(context(), incident.id))
        ?.completedAt,
    ).toBe(now.toISOString());
    expect(
      await active.diagnoses.investigationBudget(
        context(otherTenant),
        incident.id,
      ),
    ).toBeNull();
    const changed = request('active-investigation-again');
    if (changed.input.exceptionClass !== 'sync_failure')
      throw new Error('Invalid fixture');
    changed.input.facts.errorCode = 'transient';
    changed.input.facts.retryExhausted = true;
    changed.input.facts.active = true;
    now = new Date(now.getTime() + 1000);
    changed.evidence[0]!.observedAt = now.toISOString();
    await active.exceptions.ingest(context(), changed);
    expect(
      (await active.diagnoses.run(context(), incident.id))?.provenance.reread
        .status,
    ).toBe('rate_limited');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('retains Shadow predictions and evidence-backed comparisons without execution', async () => {
    now = new Date();
    const evidenceId = randomUUID();
    const source = request(evidenceId);
    source.evidence[0]!.observedAt = now.toISOString();
    const incident = (await services.exceptions.ingest(context(), source))
      .incident!;
    const diagnosis = (await services.diagnoses.run(context(), incident.id))!;
    const db = createTenantDatabase(runtime);
    const refreshContext = async (ctx: ReturnType<typeof context>) => ctx;
    const shadow = createShadowEvaluations(db, refreshContext, () => now);
    const workflow = `shadow-${randomUUID()}`;
    const first = { id: randomUUID(), workflow };
    const noCandidate = await shadow.evaluate(context(), incident.id, first);
    expect(noCandidate.eligibility).toBe('no_candidate');
    expect(await shadow.evaluate(context(), incident.id, first)).toEqual(
      noCandidate,
    );
    await expect(
      shadow.evaluate(context(), incident.id, { ...first, workflow: 'other' }),
    ).rejects.toThrow('different request');
    await expect(
      shadow.evaluate(context(otherTenant), incident.id, {
        id: randomUUID(),
        workflow,
      }),
    ).rejects.toThrow('not found');
    const effects = {
      resolve: vi.fn(async () => {
        throw new Error('Provider access forbidden');
      }),
    };
    const safety = createAdmittedSafety(
      runtimeUrl,
      { refreshContext },
      effects,
    );
    try {
      const playbooks = createResolutionPlaybooks(
        db,
        { refreshContext },
        safety,
        () => now,
      );
      const playbook = structuredClone(shippingMethodPlaybook);
      playbook.definition.id = workflow;
      playbook.ir.evidence.kind = 'sync_failure';
      const version = await playbooks.publish(context(), playbook);
      const action = {
        schemaVersion: 1 as const,
        id: randomUUID(),
        tenantId,
        connectionId,
        capability: 'orders.shipping-method.write',
        capabilityVersion: '0',
        target: { kind: 'order', id: randomUUID() },
        parameters: {},
        expectedPostcondition: { shippingMethodId: 'mapped' },
        risk: 'high' as const,
        proposedBy: { kind: 'user' as const, id: context().actor.id },
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        preconditions: {
          evidenceRefs: [evidenceId],
          validUntil: new Date(now.getTime() + 60_000).toISOString(),
        },
      };
      const activation = await playbooks.activate(context(), {
        id: randomUUID(),
        definitionId: workflow,
        version: version.version,
        grants: {
          principalIds: [context().actor.id],
          connectionIds: [connectionId],
          targetIds: [action.target.id],
        },
        policyVersion: 'v0.1',
      });
      const binding = {
        activationId: activation.id,
        incidentId: incident.id,
        diagnosisRevision: diagnosis.revision,
        action,
        snapshot: {
          inputs: { shippingMethodId: 'mapped' },
          evidence: {
            kind: 'sync_failure',
            facts: { diagnosisReady: true, methodMapped: true },
            observations: [
              {
                id: evidenceId,
                observedAt: now.toISOString(),
                source: 'production',
              },
            ],
          },
          provenance: {
            reference: 'production',
            capturedAt: now.toISOString(),
          },
        },
      };
      const candidate = await playbooks.preview(context(), binding);
      const isolated = await shadow.evaluate(
        context(),
        incident.id,
        { id: randomUUID(), workflow },
        candidate,
      );
      expect(isolated.candidate).toEqual(candidate);
      for (const table of [
        'case_proposals',
        'playbook_runs',
        'action_admission_steps',
      ]) {
        expect(
          (
            await owner.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [
              tenantId,
            ])
          ).rowCount,
        ).toBe(0);
      }
      await playbooks.bind(context(), binding);
      const desk = createDeskServices(db, { refreshContext });
      await desk.publish(context(), incident.id, diagnosis.revision, action);
      now = new Date(now.getTime() + 1);
      const input = { id: randomUUID(), workflow };
      const [prediction, retry] = await Promise.all([
        shadow.evaluate(context(), incident.id, input),
        shadow.evaluate(context(), incident.id, input),
      ]);
      expect(prediction).toEqual(retry);
      expect(prediction).toMatchObject({
        mode: 'shadow',
        executed: false,
        eligibility: 'eligible',
        policy: { outcome: 'approval_required' },
        simulation: { predictedOutcome: 'passed' },
      });
      expect(effects.resolve).not.toHaveBeenCalled();
      expect(
        (
          await owner.query(
            'SELECT 1 FROM executed_actions WHERE tenant_id=$1',
            [tenantId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (await services.exceptions.get(context(), incident.id))?.state,
      ).not.toBe('resolved');
      const review = {
        actionNeeded: true,
        eligible: true,
        operatorAction: {
          capability: action.capability,
          target: action.target,
          parameters: action.parameters,
          expectedPostcondition: action.expectedPostcondition,
        },
        evidenceRefs: [evidenceId],
        occurredAt: now.toISOString(),
        feedback: 'trust' as const,
      };
      await expect(
        shadow.review(context(), input.id, {
          ...review,
          evidenceRefs: [randomUUID()],
        }),
      ).rejects.toThrow('Evidence must belong');
      await shadow.review(context(), first.id, {
        ...review,
        operatorAction: {
          ...review.operatorAction,
          target: { kind: 'order', id: randomUUID() },
        },
      });
      await shadow.review(context(), input.id, review);
      await shadow.review(context(), input.id, review);
      await expect(
        shadow.review(context(), input.id, { ...review, actionNeeded: false }),
      ).rejects.toThrow('immutable');
      await expect(
        shadow.review(context(otherTenant), input.id, review),
      ).rejects.toThrow('not found');
      const window = {
        workflow,
        since: new Date(now.getTime() - 1000).toISOString(),
        until: new Date(now.getTime() + 1000).toISOString(),
      };
      await owner.query(
        'INSERT INTO execution_intents(id,tenant_id,action_hash,document) VALUES($1,$2,$3,$4)',
        [action.id, tenantId, candidate.actionHash, action],
      );
      const admission = await safety.policies.evaluate(
        context(),
        action,
        candidate.actionHash,
        { available: true, minimumRisk: 'high', permission: 'actions.execute' },
      );
      await createTenantDatabase(owner).transaction(tenantId, (tx) =>
        tx.query(
          `INSERT INTO executed_actions(id,tenant_id,proposal_id,idempotency_key,action_hash,state,document) VALUES($1,$2,$3,$4,$5,'unknown',$6)`,
          [
            randomUUID(),
            tenantId,
            action.id,
            `v0:${action.id}`,
            candidate.actionHash,
            {
              tenantId,
              proposalId: action.id,
              state: 'unknown',
              attempt: {
                policyDecisionId: admission.id,
                startedAt: new Date(now.getTime() - 301_000).toISOString(),
              },
            },
          ],
        ),
      );
      const verificationId = randomUUID();
      await owner.query(
        `INSERT INTO execution_verifications(tenant_id,id,proposal_id,phase,document) VALUES($1,$2,$3,'completed',$4)`,
        [
          tenantId,
          verificationId,
          action.id,
          {
            id: verificationId,
            proposalId: action.id,
            phase: 'completed',
            result: {
              outcome: 'passed',
              evaluatorVersion: 'shipping-method/1',
              observationRefs: [evidenceId],
              observedAt: now.toISOString(),
            },
          },
        ],
      );
      expect(
        (await shadow.report(context(), window)).items[0]!.actual,
      ).toBeNull();
      const rejectedId = randomUUID();
      await owner.query(
        'INSERT INTO exception_outbox(id,tenant_id,exception_id,document) VALUES($1,$2,$3,$4)',
        [
          rejectedId,
          tenantId,
          incident.id,
          {
            type: 'exception.verification_attempt',
            accepted: false,
            phase: 'completed',
            actorId: 'operator',
            occurredAt: now.toISOString(),
            evaluatorVersion: 'shipping-method/1',
            outcome: 'passed',
            evidenceRefs: [evidenceId],
            authoritative: true,
            complete: true,
          },
        ],
      );
      expect(
        (await shadow.report(context(), window)).items[0]!.actual,
      ).toBeNull();
      await owner.query(
        "UPDATE exception_outbox SET document=jsonb_set(document,'{accepted}','true') WHERE id=$1",
        [rejectedId],
      );
      expect(
        (await shadow.latest(context(), incident.id, workflow)).item?.evaluation
          .id,
      ).toBe(input.id);
      expect(
        (await shadow.latest(context(otherTenant), incident.id, workflow)).item,
      ).toBeNull();
      expect(
        (await shadow.latest(context(), randomUUID(), workflow)).item,
      ).toBeNull();
      const report = await shadow.report(context(), window);
      expect(report.items).toHaveLength(1);
      expect(report.items[0]!.actual?.outcome).toBe('passed');
      expect(report.metrics.agreementWithOperator.rate).toBe(1);
      expect(report.metrics.predictedVsActualOutcome.rate).toBe(1);
      const app = buildApp(
        { logger: false },
        {
          shadow,
          identity: {
            hasSupportView: () => false,
            resolveTenant: async () => context(),
          } as unknown as IdentityService,
        },
      );
      try {
        const response = await app.inject(
          `/v1/organizations/${tenantId}/shadow?${new URLSearchParams(window)}`,
        );
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().mode).toBe('shadow');
        const latest = await app.inject(
          `/v1/organizations/${tenantId}/exceptions/${incident.id}/shadow?workflow=${workflow}`,
        );
        expect(latest.statusCode, latest.body).toBe(200);
        expect(latest.json().item.evaluation.id).toBe(input.id);
        expect(latest.json().item.review.actorId).toBe(context().actor.id);

        expect(response.json().items[0].evaluation.executed).toBe(false);
        const invalid = await app.inject(
          `/v1/organizations/${tenantId}/shadow?workflow=${workflow}&since=invalid&until=invalid`,
        );
        expect(invalid.statusCode).toBe(400);
      } finally {
        await app.close();
      }

      expect((await shadow.report(context(otherTenant), window)).items).toEqual(
        [],
      );
      await expect(
        db.transaction(tenantId, (tx) =>
          tx.query('DELETE FROM shadow_evaluations WHERE id=$1', [input.id]),
        ),
      ).rejects.toThrow();
      const reopened = createShadowEvaluations(db, refreshContext, () => now);
      expect(await reopened.evaluate(context(), incident.id, input)).toEqual(
        prediction,
      );
      const unexecuted = await playbooks.preview(context(), {
        ...binding,
        action: { ...action, id: randomUUID() },
      });
      await playbooks.revoke(context(), activation.id);
      expect(
        (
          await shadow.evaluate(
            context(),
            incident.id,
            {
              id: randomUUID(),
              workflow,
            },
            unexecuted,
          )
        ).policy?.outcome,
      ).toBe('denied');
      await services.exceptions.resolve(context(), incident.id, {
        kind: 'human_disposition',
        reason: 'Operator resolved the incident',
        evidenceRefs: [evidenceId],
      });
      const resolved = await shadow.evaluate(
        context(),
        incident.id,
        {
          id: randomUUID(),
          workflow,
        },
        unexecuted,
      );
      expect(resolved.eligibility).toBe('ineligible');
      expect(resolved.simulation.predictedOutcome).toBe('inconclusive');
    } finally {
      await safety.close();
    }
  });
  it('reconstructs a resolution run with repairs, delayed verification and recurrence', async () => {
    now = new Date();
    const evidenceId = randomUUID();
    const source = request(evidenceId);
    source.evidence[0]!.observedAt = now.toISOString();
    const incident = (await services.exceptions.ingest(context(), source))
      .incident!;
    await services.diagnoses.run(context(), incident.id);
    const db = createTenantDatabase(runtime);
    const refreshContext = async (ctx: ReturnType<typeof context>) => ctx;
    let outcome: 'passed' | 'failed' | 'inconclusive' = 'inconclusive';
    const perform = vi.fn(async () => ({
      evidenceRefs: [evidenceId],
      providerRequestId: 'provider-43',
    }));
    const safety = createAdmittedSafety(
      runtimeUrl,
      { refreshContext },
      {
        resolve: async () => ({
          capability: 'stock.correct',
          version: '1',
          minimumRisk: 'low',
          mechanism: 'api',
          executor: { kind: 'connector', id: 'fixture' },
          checkPreconditions: async () => true,
          execute: perform,
          verify: async () => ({
            outcome,
            observationRefs: [evidenceId],
            observedAt: new Date().toISOString(),
            evaluatorVersion: 'stock-v1',
          }),
        }),
      },
      { eligible: async () => true },
    );
    const learning = createResolutionLearning(db, refreshContext, () => now);
    const artifact = await safety.provisioning.activate(context(), {
      id: 'stock-repair',
      version: randomUUID(),
      generation: { kind: 'generated', reference: 'generation-43' },
      steps: {
        execute: {
          capability: 'stock.correct',
          capabilityVersion: '1',
          targetKind: 'sku',
          minimumRisk: 'low',
        },
      },
    });
    const selection = {
      id: randomUUID(),
      diagnosisRevision: 1,
      resolution: {
        id: artifact.id,
        version: artifact.version,
        use: 'created',
        reasonCode: 'restore_stock',
      },
    };
    const run = await learning.start(context(), incident.id, selection);
    const action = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      tenantId,
      connectionId,
      capability: 'stock.correct',
      capabilityVersion: '1',
      target: { kind: 'sku', id: randomUUID() },
      parameters: { quantity: 3 },
      expectedPostcondition: { quantity: 3 },
      preconditions: {
        evidenceRefs: [evidenceId],
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      },
      risk: 'low' as const,
      proposedBy: { kind: 'user' as const, id: context().actor.id },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const append = (fact: unknown, id = randomUUID()) =>
      learning.append(context(), incident.id, run.id, {
        id,
        occurredAt: now.toISOString(),
        fact,
      });
    try {
      expect(await learning.start(context(), incident.id, selection)).toEqual(
        run,
      );
      await expect(
        learning.start(context(), incident.id, {
          ...selection,
          resolution: { ...selection.resolution, reasonCode: 'different' },
        }),
      ).rejects.toThrow('already belongs');
      await safety.provisioning.bind(context(), {
        runId: run.id,
        stepId: 'execute',
        tenantId,
        principalId: context().actor.id,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        incidentId: incident.id,
        diagnosisRevision: 1,
        action,
      });
      const cause = {
        kind: 'cause',
        code: 'mapping_error',
        status: 'suspected',
        basis: 'model_hypothesis',
        supportingEvidenceRefs: [evidenceId],
        contradictingEvidenceRefs: [],
      };
      await append(cause);
      await expect(append({ ...cause, status: 'confirmed' })).rejects.toThrow(
        'Model hypotheses',
      );
      await append({
        ...cause,
        status: 'confirmed',
        basis: 'operator_investigation',
      });
      await append({
        ...cause,
        code: 'provider_outage',
        status: 'rejected',
        basis: 'operator_investigation',
        contradictingEvidenceRefs: [evidenceId],
      });
      await append({
        kind: 'repair_step',
        stepId: 'repair-mapping',
        actionCode: 'correct_mapping',
        inputEvidenceRefs: [evidenceId],
        actionHash: 'a'.repeat(64),
        startedAt: new Date(now.getTime() - 60_000).toISOString(),
        finishedAt: now.toISOString(),
        effortSeconds: 45,
        result: 'accepted',
      });
      await append({
        kind: 'intervention',
        stepId: 'execute',
        reasonCode: 'operator_review',
        effortSeconds: 20,
        evidenceRefs: [evidenceId],
      });
      await append({
        kind: 'human_edit',
        stepId: 'execute',
        beforeHash: 'a'.repeat(64),
        afterHash: 'b'.repeat(64),
        reasonCode: 'correct_quantity',
        evidenceRefs: [evidenceId],
      });
      const observationId = randomUUID();
      const observation = {
        kind: 'observation',
        stepId: 'execute',
        code: 'provider_accepted',
        evidenceRefs: [evidenceId],
      };
      const receipts = await Promise.all(
        Array.from({ length: 4 }, () => append(observation, observationId)),
      );
      expect(new Set(receipts.map((r) => r.sequence)).size).toBe(1);
      await expect(
        append({ ...observation, code: 'changed' }, observationId),
      ).rejects.toThrow('already belongs');
      const business = {
        kind: 'outcome',
        result: 'pending',
        evaluatorVersion: 'fixture-postcondition-v1',
        authoritative: false,
        complete: false,
        evidenceRefs: [evidenceId],
        businessResult: { code: 'stock_corrected', value: 3, unit: 'piece' },
      };
      await append(business);
      await expect(
        append({
          ...business,
          result: 'verified',
          authoritative: true,
          complete: true,
        }),
      ).rejects.toThrow('authoritative verification');
      const reference = { runId: run.id, stepId: 'execute' };
      expect((await safety.execution.execute(context(), reference)).state).toBe(
        'reconciliation_required',
      );
      outcome = 'failed';
      expect(
        (await safety.execution.reconcile(context(), action.id)).state,
      ).toBe('reconciliation_required');
      outcome = 'passed';
      expect(
        (await safety.execution.reconcile(context(), action.id)).state,
      ).toBe('succeeded');
      expect(perform).toHaveBeenCalledTimes(1);
      // Canonical verification is independent from the connector's successful action.
      now = new Date();
      const proof = verification(incident);
      proof.evidence[0]!.observedAt = now.toISOString();
      evaluate.mockRejectedValueOnce(new Error('private-customer-payload'));
      await expect(
        services.exceptions.verify(context(), incident.id),
      ).rejects.toThrow();
      evaluate.mockResolvedValueOnce({ ...proof, outcome: 'inconclusive' });
      expect(await services.exceptions.verify(context(), incident.id)).toBe(
        false,
      );
      evaluate.mockResolvedValueOnce(proof);
      expect(await services.exceptions.verify(context(), incident.id)).toBe(
        true,
      );
      await append({
        ...business,
        result: 'verified',
        authoritative: true,
        complete: true,
        evidenceRefs: ['verification-1'],
      });
      const discovery = createResolutionImprovementDiscovery(
        db,
        refreshContext,
        async () => true,
        () => new Date(now.getTime() + 1),
      );
      const discovered = await discovery.discover(context());
      expect(discovered.items).toHaveLength(1);
      expect(discovered.items[0]).toMatchObject({
        pattern: 'sync_failure',
        environment: 'unknown',
        verifiedIncidents: 1,
        humanInterventions: 1,
        humanEdits: 1,
        eligibleForProposal: false,
        productionPromotion: 'blocked',
        sources: [{ incidentId: incident.id, runId: run.id }],
      });
      expect((await discovery.discover(context(otherTenant))).items).toEqual(
        [],
      );
      const recurrenceSource = request(randomUUID());
      recurrenceSource.evidence[0]!.observedAt = now.toISOString();
      const recurrence = (
        await services.exceptions.ingest(context(), recurrenceSource)
      ).incident!;
      await append({
        kind: 'recurrence',
        incidentId: recurrence.id,
        evidenceRefs: [evidenceId],
      });
      const reopened = createResolutionLearning(db, refreshContext, () => now);
      const history = await reopened.read(context(), incident.id, run.id);
      expect(
        (await reopened.list(context(), incident.id)).items.map(
          (item) => item.id,
        ),
      ).toEqual([run.id]);
      expect(
        (await reopened.list(context(), incident.id, run.id)).items,
      ).toEqual([]);
      expect(history.run.context.evidenceRefs).toEqual([evidenceId]);
      expect(history.run.context.configVersion).toBe(
        defaultConfiguration.version,
      );
      expect(history.run.generation).toEqual({
        kind: 'generated',
        reference: 'generation-43',
      });
      expect(history.steps[0]!.action.parameters).toEqual({ quantity: 3 });
      expect(history.executions[0]!.actionHash).toBe(
        history.steps[0]!.actionHash,
      );
      expect(history.executions[0]!.attempt.providerRequestId).toBe(
        'provider-43',
      );
      expect(
        history.verifications.filter((v) => v.phase === 'pending'),
      ).toHaveLength(3);
      expect(
        history.verifications
          .filter((v) => v.phase === 'completed')
          .map((v) => v.result?.outcome),
      ).toEqual(['inconclusive', 'failed', 'passed']);
      expect(history.incidentVerifications).toHaveLength(6);
      expect(
        history.incidentVerifications.filter((v) => v.phase === 'completed'),
      ).toEqual([
        expect.objectContaining({ failureCode: 'evaluation_failed' }),
        expect.objectContaining({ outcome: 'inconclusive', accepted: false }),
        expect.objectContaining({ outcome: 'passed', accepted: true }),
      ]);
      expect(JSON.stringify(history)).not.toContain('private-customer-payload');
      expect(history.events.map((e) => e.sequence)).toEqual(
        history.events.map((_, i) => i + 1),
      );
      expect(
        history.events.every((e) => e.actorId === context().actor.id),
      ).toBe(true);
      expect(history.recurrences.map((r) => r.id)).toEqual([recurrence.id]);
      expect(history.incident.resolution?.kind).toBe('verification');
      await expect(
        reopened.read(context(otherTenant), incident.id, run.id),
      ).rejects.toThrow('not found');
      await expect(
        reopened.read(decisionActor('member', 'member'), incident.id, run.id),
      ).rejects.toThrow('role');
      await expect(
        append({ ...observation, evidenceRefs: ['foreign-evidence'] }),
      ).rejects.toThrow('belong to this incident');
      await expect(
        db.transaction(tenantId, (tx) =>
          tx.query('UPDATE resolution_runs SET document=document WHERE id=$1', [
            run.id,
          ]),
        ),
      ).rejects.toThrow('permission denied');
      await expect(
        db.transaction(tenantId, (tx) =>
          tx.query('DELETE FROM resolution_learning_events WHERE run_id=$1', [
            run.id,
          ]),
        ),
      ).rejects.toThrow('permission denied');
      const historicalRunId = randomUUID();
      const historicalBinding = {
        runId: historicalRunId,
        stepId: 'execute',
        tenantId,
        principalId: context().actor.id,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        incidentId: incident.id,
        diagnosisRevision: 1,
        action: { ...action, id: randomUUID() },
      };
      await safety.provisioning.bind(context(), historicalBinding);
      await safety.provisioning.revoke(
        context(),
        artifact.id,
        artifact.version,
      );
      // Exact retries retain the original selection even after its artifact is revoked.
      expect(await learning.start(context(), incident.id, selection)).toEqual(
        run,
      );
      await services.diagnoses.run(context(), recurrence.id);
      await expect(
        learning.start(context(), recurrence.id, {
          ...selection,
          id: historicalRunId,
        }),
      ).rejects.toThrow('binding conflicts');
      await expect(
        learning.start(context(), incident.id, {
          ...selection,
          id: historicalRunId,
        }),
      ).resolves.toMatchObject({ id: historicalRunId });
      await expect(
        learning.start(context(), incident.id, {
          ...selection,
          id: randomUUID(),
        }),
      ).rejects.toThrow('revoked');
      await expect(
        learning.append(context(), incident.id, historicalRunId, {
          id: observationId,
          occurredAt: receipts[0]!.occurredAt,
          fact: observation,
        }),
      ).rejects.toThrow('already belongs');
      expect(
        (await learning.read(context(), incident.id, run.id)).events,
      ).toEqual(history.events);
      await expect(
        safety.provisioning.bind(context(), {
          ...historicalBinding,
          stepId: 'another',
          action: { ...action, id: randomUUID() },
        }),
      ).rejects.toThrow('not activated');
      const app = buildApp(
        { logger: false },
        {
          learning: reopened,
          identity: {
            hasSupportView: () => false,
            resolveTenant: async () => context(),
          } as unknown as IdentityService,
        },
      );
      try {
        const response = await app.inject(
          `/v1/organizations/${tenantId}/exceptions/${incident.id}/resolution-runs/${run.id}`,
        );
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().verifications).toHaveLength(6);
      } finally {
        await app.close();
      }
    } finally {
      await safety.close();
    }
  });
  it('serves scoped overview counts, bounded priority and explicit metric availability', async () => {
    for (let i = 0; i < 7; i++) {
      const value = request(`overview-${i}`);
      if (value.input.exceptionClass !== 'sync_failure')
        throw new Error('fixture');
      value.input.facts.connectionId = randomUUID();
      value.input.facts.subjectId = value.input.facts.connectionId;
      value.evidence[0]!.connectionId = value.input.facts.connectionId;
      const incident = (await services.exceptions.ingest(context(), value))
        .incident!;
      await owner.query(
        `UPDATE exceptions SET state='escalated',
        document=document || $2::jsonb WHERE id=$1`,
        [
          incident.id,
          { state: 'escalated', severity: i === 0 ? 'medium' : 'high' },
        ],
      );
    }
    const service = createOperationsOverview(
      services.cases,
      createConnectionCoverage(createTenantDatabase(runtime)),
      () => now,
    );
    const app = buildApp(
      {},
      {
        operations: service,
        identity: {
          hasSupportView: () => false,
          resolveTenant: async (_credentials: unknown, id: string) =>
            context(id),
        } as unknown as IdentityService,
      },
    );
    try {
      const response = await app.inject(
        `/v1/organizations/${tenantId}/operations/overview?window=7d`,
      );
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        attentionCount: 7,
        activeCount: 7,
        automaticallyResolved: null,
        automation: null,
        connections: [],
      });
      expect(Date.parse(body.window.end) - Date.parse(body.window.start)).toBe(
        7 * 86400000,
      );
      expect(body.prioritizedDecisions).toHaveLength(5);
      expect(
        body.prioritizedDecisions.every(
          (item: { severity: string }) => item.severity === 'high',
        ),
      ).toBe(true);
      const expected = await services.cases.list(
        context(),
        caseQuerySchema.parse({ limit: 5 }),
      );
      expect(body.prioritizedDecisions).toEqual(expected.items);
      expect(
        (
          await app.inject(
            `/v1/organizations/${otherTenant}/operations/overview`,
          )
        ).json(),
      ).toMatchObject({
        attentionCount: 0,
        activeCount: 0,
        prioritizedDecisions: [],
      });
      expect(
        (
          await app.inject(
            `/v1/organizations/${tenantId}/operations/overview?window=invalid`,
          )
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('counts verified resolutions only within the selected half-open window', async () => {
    const incident = (await services.exceptions.ingest(context(), request()))
      .incident!;
    const end = now.toISOString();
    const at = new Date(now.getTime() - 86400000).toISOString();
    await owner.query(
      `UPDATE exceptions SET state='resolved',document=document || $2::jsonb WHERE id=$1`,
      [
        incident.id,
        {
          state: 'resolved',
          resolution: {
            kind: 'verification',
            actorId: 'fixture',
            auditId: 'fixture',
            evidenceRefs: ['fixture'],
            outcome: 'passed',
            complete: true,
            authoritative: true,
            at,
          },
        },
      ],
    );
    expect(await services.cases.overview(context(), at, end)).toMatchObject({
      verifiedResolutions: 1,
      attentionCount: 0,
      activeCount: 0,
    });
    expect(
      await services.cases.overview(
        context(),
        new Date(Date.parse(at) + 1).toISOString(),
        end,
      ),
    ).toMatchObject({ verifiedResolutions: 0 });
    expect(
      await services.cases.overview(
        context(),
        new Date(Date.parse(at) - 86400000).toISOString(),
        at,
      ),
    ).toMatchObject({ verifiedResolutions: 0 });
  });
  it('requires per-capability observations and keeps connector secrets inaccessible to overview readers', async () => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,'encrypted-fixture')`,
      [
        tenantId,
        id,
        {
          tenantId,
          id,
          version: 1,
          status: 'active',
          label: 'Shopify',
          granted: ['orders.read', 'inventory.read'],
          permissions: ['orders.read', 'inventory.read'],
        },
      ],
    );
    const coverage = createConnectionCoverage(createTenantDatabase(runtime));
    const asOf = now.toISOString();
    try {
      expect(await coverage(context(), asOf)).toMatchObject([
        { freshness: 'unobserved', lastObservedAt: null },
      ]);
      const insert = async (capability: string, observedAt: string) =>
        owner.query(
          `INSERT INTO connector_observations(id,tenant_id,connection_id,ingest_key,document) VALUES($1,$2,$3,$5,$4)`,
          [
            randomUUID(),
            tenantId,
            id,
            {
              capability,
              observation: {
                source: { tenantId, connectionId: id },
                observedAt,
              },
            },
            randomUUID(),
          ],
        );
      await insert('orders.read', asOf);
      expect(await coverage(context(), asOf)).toMatchObject([
        { freshness: 'unobserved' },
      ]);
      await insert(
        'inventory.read',
        new Date(now.getTime() - 86400001).toISOString(),
      );
      expect(await coverage(context(), asOf)).toMatchObject([
        { freshness: 'stale' },
      ]);
      await insert(
        'inventory.read',
        new Date(now.getTime() + 60000).toISOString(),
      );
      expect(await coverage(context(), asOf)).toMatchObject([
        { freshness: 'stale' },
      ]);
      await insert('inventory.read', asOf);
      expect(await coverage(context(), asOf)).toMatchObject([
        { freshness: 'fresh', lastObservedAt: asOf },
      ]);
      expect(await coverage(context(otherTenant), asOf)).toEqual([]);
      await expect(
        runtime.query('SELECT secret FROM connector_installations'),
      ).rejects.toThrow('permission denied');
    } finally {
      await owner.query(
        'DELETE FROM connector_observations WHERE connection_id=$1',
        [id],
      );
      await owner.query('DELETE FROM connector_installations WHERE id=$1', [
        id,
      ]);
    }
  });
  it('serves persisted pending and ready investigations without running a model', async () => {
    const result = await services.exceptions.ingest(context(), request());
    const id = result.incident!.id;
    const app = buildApp(
      {},
      {
        cases: services.cases,
        identity: {
          hasSupportView: () => false,
          resolveTenant: async () => context(),
        } as unknown as IdentityService,
      },
    );
    try {
      const pending = await app.inject(
        `/v1/organizations/${tenantId}/exceptions/${id}`,
      );
      expect(pending.statusCode).toBe(200);
      expect(caseDetailSchema.parse(pending.json()).diagnosisStatus).toBe(
        'pending',
      );
      const attention = await services.cases.list(
        context(),
        caseQuerySchema.parse({}),
      );
      expect(attention.items).toEqual([]);
      await services.diagnoses.run(context(), id);
      const ready = await app.inject(
        `/v1/organizations/${tenantId}/exceptions/${id}`,
      );
      expect(ready.statusCode).toBe(200);
      expect(ready.json().diagnosisStatus).toBe('ready');
      expect(ready.json().diagnosis.facts.length).toBeGreaterThan(0);
      const list = await app.inject(
        `/v1/organizations/${tenantId}/exceptions?view=active`,
      );
      expect(list.statusCode).toBe(200);
      expect(list.json().items[0].id).toBe(id);
      expect(list.json().items[0]).not.toHaveProperty('diagnosis');
      expect(await services.cases.get(context(otherTenant), id)).toBeNull();
      expect(
        (
          await services.cases.list(
            context(otherTenant),
            caseQuerySchema.parse({ view: 'active' }),
          )
        ).items,
      ).toEqual([]);
      const bad = await app.inject(
        `/v1/organizations/${tenantId}/exceptions?cursor=bad`,
      );
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it.each([100, 101])(
    'keeps cases with %i persisted evidence entries readable',
    async (count) => {
      const value = request();
      value.evidence = Array.from({ length: count }, (_, i) => ({
        ...value.evidence[0]!,
        key: `evidence-${String(i).padStart(3, '0')}`,
        source: {
          provider: `provider-${i}`,
          resource: 'inventory',
          externalId: `stock-${i}`,
          scopeKey: 'pool',
        },
      }));
      value.input.facts.evidenceRefs = value.evidence.map((e) => e.key);
      const id = (await services.exceptions.ingest(context(), value)).incident!
        .id;
      const persisted = async () =>
        (
          await owner.query(
            'SELECT document FROM exception_diagnoses WHERE tenant_id=$1 AND exception_id=$2',
            [tenantId, id],
          )
        ).rows[0].document;
      const original = await persisted();
      expect(original.provenance.evidence).toHaveLength(count);
      const app = buildApp(
        {},
        {
          cases: services.cases,
          identity: {
            hasSupportView: () => false,
            resolveTenant: async () => context(),
          } as unknown as IdentityService,
        },
      );
      try {
        const detail = await app.inject(
          `/v1/organizations/${tenantId}/exceptions/${id}`,
        );
        expect(detail.statusCode).toBe(200);
        const body = caseDetailSchema.parse(detail.json());
        expect(body.diagnosisStatus).toBe('pending');
        expect(body.diagnosis!.provenance.evidence).toHaveLength(100);
        expect(body.diagnosis!.attention.evidenceRefs).toHaveLength(100);
        expect(body.sources).toHaveLength(100);
        expect(body.diagnosis!.nextSteps).toEqual([]);
        if (count > 100)
          expect(body.diagnosis!.constraints).toContain(
            'Only 100 of 101 evidence references are shown. Findings and recommendations are withheld until the full evidence can be reviewed.',
          );
        const list = await app.inject(
          `/v1/organizations/${tenantId}/exceptions?view=active`,
        );
        expect(list.statusCode).toBe(200);
        expect(list.json().items[0].id).toBe(id);
        expect(list.json().items[0].sources).toHaveLength(100);
        expect(await services.cases.get(context(otherTenant), id)).toBeNull();
        expect(await persisted()).toEqual(original);
      } finally {
        await app.close();
      }
    },
  );
  it('paginates immutable historical evidence through the typed client without running investigations', async () => {
    const value = request();
    value.evidence = Array.from({ length: 125 }, (_, i) => ({
      ...value.evidence[0]!,
      key: `evidence-${String(i).padStart(3, '0')}`,
      facts: {
        complete: i === 0 ? true : i === 1 ? false : null,
        secret: 'not-public',
      },
    }));
    value.input.facts.evidenceRefs = value.evidence.map((e) => e.key);
    const id = (await services.exceptions.ingest(context(), value)).incident!
      .id;
    const later = request('later-observation');
    later.evidence.push(value.evidence[0]!);
    later.input.facts.evidenceRefs.push(value.evidence[0]!.key);
    await services.exceptions.ingest(context(), later);
    const run = vi.spyOn(services.diagnoses, 'run');
    const resolveTenant = vi
      .fn<IdentityService['resolveTenant']>()
      .mockResolvedValue(context());
    const app = buildApp(
      {},
      {
        cases: services.cases,
        identity: {
          resolveTenant,
          hasSupportView: () => false,
        } as unknown as IdentityService,
      },
    );
    try {
      const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
      const client = createApiClient({ baseUrl });
      const params = { organizationId: tenantId, exceptionId: id };
      const first = await client.exceptions.evidence({ params, query: {} });
      expect(first.items).toHaveLength(25);
      expect(first.items.slice(0, 3).map((e) => e.completeness)).toEqual([
        'complete',
        'incomplete',
        'unknown',
      ]);
      expect(first.items[0]).toMatchObject({
        id: 'evidence-000',
        sourceUpdatedAt: null,
        observedAt: corpus.now,
      });
      expect(JSON.stringify(first)).not.toContain('not-public');
      const items = [...first.items];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = await client.exceptions.evidence({
          params,
          query: { cursor },
        });
        items.push(...page.items);
        cursor = page.nextCursor;
      }
      expect(items.map((e) => e.id)).toEqual([
        ...value.evidence.map((e) => e.key),
        'later-observation',
      ]);
      const detail = await services.cases.get(context(), id);
      expect(detail!.diagnosis!.provenance.evidence.map((e) => e.id)).toEqual([
        'evidence-000',
        'later-observation',
      ]);
      expect(run).not.toHaveBeenCalled();
      await client.exceptions.evidence({ params, query: { limit: 100 } });
      for (const query of [
        { limit: 101 },
        { limit: 0 },
        { cursor: 'bad' },
        { cursor: first.nextCursor!, limit: 24 },
        { cursor: first.nextCursor! + '=' },
        {
          cursor: Buffer.from(
            JSON.stringify({ context: 'wrong', id: 'evidence-000' }),
          ).toString('base64url'),
        },
      ])
        await expect(
          client.exceptions.evidence({ params, query }),
        ).rejects.toMatchObject({ status: 400 });
      const other = request('other-case');
      if (other.input.exceptionClass !== 'sync_failure')
        throw new Error('Fixture');
      const otherConnection = randomUUID();
      other.input.facts.connectionId = otherConnection;
      other.input.facts.subjectId = otherConnection;
      other.evidence[0]!.connectionId = otherConnection;
      const otherId = (await services.exceptions.ingest(context(), other))
        .incident!.id;
      await expect(
        client.exceptions.evidence({
          params: { ...params, exceptionId: otherId },
          query: { cursor: first.nextCursor! },
        }),
      ).rejects.toMatchObject({ status: 400 });
      const listCursor = (
        await services.cases.list(
          context(),
          caseQuerySchema.parse({ view: 'active', limit: 1 }),
        )
      ).nextCursor;
      expect(listCursor).not.toBeNull();
      await expect(
        client.exceptions.evidence({ params, query: { cursor: listCursor! } }),
      ).rejects.toMatchObject({ status: 400 });

      expect(
        await services.cases.evidence(context(otherTenant), id, { limit: 25 }),
      ).toBeNull();
      const foreignId = (
        await services.exceptions.ingest(
          context(otherTenant),
          request('foreign-evidence', otherTenant),
        )
      ).incident!.id;
      const notFound = {
        status: 404,
        body: { code: 'NOT_FOUND', message: 'Case not found' },
      };
      await expect(
        client.exceptions.evidence({
          params: { ...params, exceptionId: randomUUID() },
          query: {},
        }),
      ).rejects.toMatchObject(notFound);
      await expect(
        client.exceptions.evidence({
          params: { ...params, exceptionId: foreignId },
          query: {},
        }),
      ).rejects.toMatchObject(notFound);
      resolveTenant.mockResolvedValueOnce(context(otherTenant));
      await expect(
        client.exceptions.evidence({
          params: { organizationId: otherTenant, exceptionId: foreignId },
          query: { cursor: first.nextCursor! },
        }),
      ).rejects.toMatchObject({ status: 400 });
      resolveTenant.mockRejectedValueOnce(
        new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue'),
      );
      await expect(
        client.exceptions.evidence({
          params,
          query: { cursor: first.nextCursor! },
        }),
      ).rejects.toMatchObject({ status: 401 });
      resolveTenant.mockRejectedValueOnce(
        new IdentityError(404, 'NOT_FOUND', 'Organization not found'),
      );
      await expect(
        client.exceptions.evidence({ params, query: {} }),
      ).rejects.toMatchObject(notFound);
    } finally {
      run.mockRestore();
      await app.close();
    }
  });
  it('paginates evidence from current and superseded non-detection investigations', async () => {
    const incident = (
      await services.exceptions.ingest(context(), request('detected'))
    ).incident!;
    for (const [key, complete] of [
      ['deferred', false],
      ['cleared', true],
    ] as const) {
      const next = request(key);
      if (next.input.exceptionClass !== 'sync_failure')
        throw new Error('Fixture');
      next.input.facts.status = 'success';
      next.input.facts.errorCode = null;
      next.input.facts.scanComplete = complete;
      expect(
        (await services.exceptions.ingest(context(), next)).decision.decision,
      ).toBe(complete ? 'clear' : 'defer');
      await services.diagnoses.run(context(), incident.id);
    }
    expect(
      (await services.diagnoses.get(
        context(),
        incident.id,
      ))!.provenance.evidence.map((e) => e.id),
    ).toEqual(['cleared']);
    const refreshContext = async (ctx: ReturnType<typeof context>) => ctx;
    const safety = createAdmittedSafety(
      runtimeUrl,
      { refreshContext },
      { resolve: async () => null },
      { eligible: async () => true },
    );
    try {
      const artifact = await safety.provisioning.activate(context(), {
        id: 'diagnosis-evidence',
        version: '1',
        generation: { kind: 'generated', reference: 'fixture' },
        steps: {
          execute: {
            capability: 'stock.correct',
            capabilityVersion: '1',
            targetKind: 'sku',
            minimumRisk: 'low',
          },
        },
      });
      const learning = createResolutionLearning(
        createTenantDatabase(runtime),
        refreshContext,
        () => now,
      );
      const diagnosis = (await services.diagnoses.get(context(), incident.id))!;
      const run = await learning.start(context(), incident.id, {
        id: randomUUID(),
        diagnosisRevision: diagnosis.revision,
        resolution: {
          id: artifact.id,
          version: artifact.version,
          use: 'created',
          reasonCode: 'investigate',
        },
      });
      expect(run.context.evidenceRefs).toEqual(['cleared']);
      const appendCause = (refs: string[]) =>
        learning.append(context(), incident.id, run.id, {
          id: randomUUID(),
          occurredAt: now.toISOString(),
          fact: {
            kind: 'cause',
            code: 'provider_outage',
            status: 'rejected',
            basis: 'operator_investigation',
            supportingEvidenceRefs: [],
            contradictingEvidenceRefs: refs,
          },
        });
      await expect(appendCause(['cleared', 'deferred'])).resolves.toMatchObject(
        { fact: { contradictingEvidenceRefs: ['cleared', 'deferred'] } },
      );
      await services.exceptions.ingest(
        context(otherTenant),
        request('foreign-tenant', otherTenant),
      );
      const foreign = request('foreign-incident');
      if (foreign.input.exceptionClass !== 'sync_failure')
        throw new Error('Fixture');
      foreign.input.facts.connectionId = randomUUID();
      foreign.input.facts.subjectId = foreign.input.facts.connectionId;
      foreign.evidence[0]!.connectionId = foreign.input.facts.connectionId;
      await services.exceptions.ingest(context(), foreign);
      for (const key of ['foreign-tenant', 'foreign-incident']) {
        await expect(appendCause([key])).rejects.toThrow(
          'belong to this incident',
        );
      }
    } finally {
      await safety.close();
    }
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE luma_case_reader');
      const reader = createCases({
        transaction: async (tenant, operation) => {
          await client.query("SELECT set_config('app.tenant_id',$1,true)", [
            tenant,
          ]);

          return operation(client);
        },
      });
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = (await reader.evidence(context(), incident.id, {
          limit: 1,
          ...(cursor ? { cursor } : {}),
        }))!;
        ids.push(...page.items.map((e) => e.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(ids).toEqual(['cleared', 'deferred', 'detected']);
      expect(
        await reader.evidence(context(otherTenant), incident.id, { limit: 1 }),
      ).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('includes verification evidence and grants only scoped SELECT access for evidence reads', async () => {
    const incident = (await services.exceptions.ingest(context(), request()))
      .incident!;
    evaluate.mockResolvedValue(verification(incident));
    expect(await services.exceptions.verify(context(), incident.id)).toBe(true);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE luma_case_reader');
      const reader = createCases({
        transaction: async (tenant, operation) => {
          await client.query("SELECT set_config('app.tenant_id',$1,true)", [
            tenant,
          ]);

          return operation(client);
        },
      });
      const page = await reader.evidence(context(), incident.id, { limit: 25 });
      expect(page!.items.map((e) => e.id)).toEqual([
        'event-1',
        'verification-1',
      ]);
      expect(
        await reader.evidence(context(otherTenant), incident.id, { limit: 25 }),
      ).toBeNull();
      for (const table of [
        'exception_evidence',
        'exception_inputs',
        'exception_sources',
      ])
        expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
      await expect(
        client.query('DELETE FROM exception_evidence'),
      ).rejects.toThrow('permission denied');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  function decisionActor(
    role: 'owner' | 'admin' | 'member' = 'admin',
    user = 'approver',
    tenant: string = tenantId,
  ) {
    return makeTenantContext(
      { userId: user, sessionId: 'session' },
      {
        id: tenant,
        name: 'Fixture',
        slug: 'fixture',
        dataRegion: 'EU',
        status: 'active',
      },
      builtInMembership(
        { id: 'membership', organizationId: tenant, userId: user },
        role,
      ),
      randomUUID(),
    );
  }

  async function decisionFixture(capability = 'stock.correct') {
    now = new Date();
    const evidenceId = randomUUID();
    const input = request(evidenceId);
    input.evidence[0]!.observedAt = now.toISOString();
    const incident = (await services.exceptions.ingest(context(), input))
      .incident!;
    await services.diagnoses.run(context(), incident.id);
    const perform = vi.fn(async () => ({ evidenceRefs: [evidenceId] }));
    const check = vi.fn(async () => true);
    const registry = {
      resolve: async () => ({
        capability,
        version: '1',
        minimumRisk: 'medium' as const,
        mechanism: 'api' as const,
        executor: { kind: 'connector' as const, id: 'fixture' },
        checkPreconditions: check,
        execute: perform,
        verify: async () => ({
          outcome: 'passed' as const,
          observationRefs: [evidenceId],
          observedAt: new Date().toISOString(),
          evaluatorVersion: 'fixture',
        }),
      }),
    };
    const refreshContext = vi.fn(
      async (actor: ReturnType<typeof context>) => actor,
    );
    const desk = createDeskServices(
      createTenantDatabase(runtime),
      { refreshContext },
      registry,
      {
        capability: (a) =>
          a.capability === 'stock.correct' && a.capabilityVersion === '1',
        now: () => now,
      },
    );
    const safety = createSafetyServices(
      runtimeUrl,
      { refreshContext },
      registry,
    );
    const diagnosis = (await services.cases.get(context(), incident.id))!
      .diagnosis!;
    const action = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      tenantId,
      capability,
      capabilityVersion: '1',
      connectionId,
      target: { kind: 'sku', id: randomUUID() },
      parameters: { quantity: '3.000001', unit: 'piece' },
      expectedPostcondition: { quantity: '3.000001', unit: 'piece' },
      preconditions: {
        evidenceRefs: [evidenceId],
        validUntil: new Date(now.getTime() + 60_000).toISOString(),
      },
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      risk: 'medium' as const,
      proposedBy: { kind: 'user' as const, id: context().actor.id },
    };
    await desk.publish(context(), incident.id, diagnosis.revision, action);
    const result = await safety.execution.execute(context(), action);
    expect(result.state).toBe('approval_required');
    const review = await desk.review(decisionActor(), incident.id);
    const command = {
      commandId: randomUUID(),
      kind: 'approve' as const,
      caseRevision: review.caseRevision,
      diagnosisRevision: review.diagnosisRevision,
      proposalId: action.id,
      proposalVersion: 1,
      decisionId: review.proposal!.policy!.id,
      reason: 'Reviewed current evidence',
    };

    return {
      desk,
      safety,
      action,
      incident,
      command,
      perform,
      check,
      refreshContext,
    };
  }

  it('preserves approval request age when the workflow reevaluates the same proposal', async () => {
    const f = await decisionFixture();
    try {
      const before = (await services.cases.get(context(), f.incident.id))!;
      const firstPolicy = (await f.desk.review(decisionActor(), f.incident.id))
        .proposal!.policy!;
      expect(before.attention.reason).toBe('approval');
      // Separate clock ticks make an accidental reset observable without delaying the test.
      await owner.query(
        "UPDATE policy_decisions SET document=jsonb_set(document,'{evaluatedAt}',to_jsonb($2::text)) WHERE id=$1",
        [
          firstPolicy.id,
          new Date(Date.parse(firstPolicy.evaluatedAt) - 30_000).toISOString(),
        ],
      );
      const original = (await services.cases.get(context(), f.incident.id))!
        .attention.requestedAt;
      expect(
        (await f.safety.execution.execute(context(), f.action)).state,
      ).toBe('approval_required');
      const current = (await f.desk.review(decisionActor(), f.incident.id))
        .proposal!.policy!;
      expect(current.id).not.toBe(firstPolicy.id);
      const detail = (await services.cases.get(context(), f.incident.id))!;
      expect(detail.attention.requestedAt).toBe(original);
      expect(detail.lastActivityAt).toBe(current.evaluatedAt);
      const list = await services.cases.list(
        context(),
        caseQuerySchema.parse({ view: 'needs_you' }),
      );
      expect(
        list.items.find((item) => item.id === f.incident.id)!.attention
          .requestedAt,
      ).toBe(original);
    } finally {
      await f.safety.close();
    }
  });
  it('commits one decision receipt under retries and separates approval, execution and verified resolution', async () => {
    const f = await decisionFixture();
    try {
      expect(
        (await f.desk.review(decisionActor(), f.incident.id))
          .permittedDecisions,
      ).toEqual(['close', 'escalate', 'reject', 'approve']);
      expect(
        (await f.desk.review(context(), f.incident.id)).permittedDecisions,
      ).toEqual(['close', 'escalate']);
      expect(
        (await f.desk.review(decisionActor('member'), f.incident.id))
          .permittedDecisions,
      ).toEqual([]);
      expect(
        (await services.cases.get(context(), f.incident.id))!.attention.reason,
      ).toBe('approval');
      expect(
        (await f.desk.review(decisionActor(), f.incident.id)).proposal!
          .parameters.quantity,
      ).toBe('3.000001');
      // Recover a policy event whose audit append committed before its delivery marker.
      await owner.query(
        'UPDATE policy_outbox SET delivered_at=NULL WHERE tenant_id=$1',
        [tenantId],
      );
      const receipts = await Promise.all(
        Array.from({ length: 8 }, () =>
          f.desk.decide(decisionActor(), f.incident.id, f.command),
        ),
      );
      expect(new Set(receipts.map((r) => r.approvalId)).size).toBe(1);
      expect(f.perform).not.toHaveBeenCalled();
      expect(
        await f.desk.receipt(
          decisionActor(),
          f.incident.id,
          f.command.commandId,
        ),
      ).toEqual(receipts[0]);
      await expect(
        f.desk.receipt(context(), f.incident.id, f.command.commandId),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        f.desk.decide(decisionActor(), f.incident.id, {
          ...f.command,
          kind: 'reject',
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        f.desk.decide(decisionActor(), f.incident.id, {
          ...f.command,
          commandId: randomUUID(),
          kind: 'reject',
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const executions = await Promise.all(
        Array.from({ length: 4 }, () =>
          f.safety.execution.execute(context(), f.action),
        ),
      );
      expect(executions.some((e) => e.state === 'succeeded')).toBe(true);
      expect(f.perform).toHaveBeenCalledTimes(1);
      expect(
        await f.desk.publish(
          context(),
          f.incident.id,
          f.command.diagnosisRevision,
          f.action,
        ),
      ).toMatchObject({ action: f.action });
      const progress = await f.desk.progress(decisionActor(), f.incident.id);
      expect(progress.execution?.state).toBe('succeeded');
      expect(progress.resolution).toBeNull();
      const proof = verification(f.incident);
      proof.evidence[0]!.observedAt = now.toISOString();
      evaluate.mockResolvedValue(proof);
      expect(await services.exceptions.verify(context(), f.incident.id)).toBe(
        true,
      );
      expect(
        (await f.desk.progress(decisionActor(), f.incident.id)).resolution
          ?.kind,
      ).toBe('verification');
      const firstPage = await f.desk.timeline(context(), f.incident.id, {
        limit: 1,
      });
      expect(firstPage.nextCursor).not.toBeNull();
      await expect(
        f.desk.timeline(context(), f.incident.id, {
          limit: 2,
          cursor: firstPage.nextCursor!,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        f.desk.timeline(context(otherTenant), f.incident.id, {
          limit: 1,
          cursor: firstPage.nextCursor!,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      const items = [];
      let cursor: string | undefined;
      do {
        const page = await f.desk.timeline(context(), f.incident.id, {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(new Set(items.map((e) => e.id)).size).toBe(items.length);
      expect(items.map((e) => e.type)).toEqual(
        expect.arrayContaining([
          'case.approve',
          'approval.responded',
          'execution.completed',
          'exception.resolved',
        ]),
      );
      expect(
        (await owner.query('SELECT count(*) FROM case_commands')).rows[0].count,
      ).toBe('1');
      expect(
        (await owner.query('SELECT count(*) FROM policy_approvals')).rows[0]
          .count,
      ).toBe('1');
    } finally {
      await f.safety.close();
    }
  });
  it.each([
    'revision',
    'diagnosis',
    'proposal',
    'version',
    'decision',
    'capability',
    'expired',
    'permission',
  ] as const)(
    'rejects %s changes before committing an approval',
    async (mode) => {
      const f = await decisionFixture();
      try {
        const command = { ...f.command };
        let actor = decisionActor();
        if (mode === 'revision') command.caseRevision++;
        if (mode === 'diagnosis') command.diagnosisRevision++;
        if (mode === 'proposal') command.proposalId = randomUUID();
        if (mode === 'version') command.proposalVersion++;
        if (mode === 'decision') command.decisionId = randomUUID();
        if (mode === 'capability') f.check.mockResolvedValue(false);
        if (mode === 'expired') now = new Date(now.getTime() + 120_000);
        if (mode === 'permission') actor = decisionActor('member');
        await expect(
          f.desk.decide(actor, f.incident.id, command),
        ).rejects.toMatchObject({
          statusCode: mode === 'permission' ? 403 : 409,
        });
        expect(
          (await owner.query('SELECT count(*) FROM policy_approvals')).rows[0]
            .count,
        ).toBe('0');
        expect(f.perform).not.toHaveBeenCalled();
      } finally {
        await f.safety.close();
      }
    },
  );
  it('keeps unknown capabilities disabled, rejects immutable changes and denies tenant crossover', async () => {
    const f = await decisionFixture('unknown.write');
    try {
      const review = await f.desk.review(decisionActor(), f.incident.id);
      expect(review.proposal!.available).toBe(false);
      expect(review.permittedDecisions).not.toContain('approve');
      await expect(
        f.desk.publish(context(), f.incident.id, review.diagnosisRevision, {
          ...f.action,
          parameters: { quantity: '99' },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      for (const id of [f.incident.id, randomUUID()])
        await expect(
          f.desk.review(context(otherTenant), id),
        ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        f.desk.decide(context(otherTenant), f.incident.id, f.command),
      ).rejects.toMatchObject({ statusCode: 404 });
      await f.desk.decide(decisionActor(), f.incident.id, {
        ...f.command,
        kind: 'reject',
      });
      expect(
        (await f.safety.execution.execute(context(), f.action)).state,
      ).toBe('denied');
      expect(f.perform).not.toHaveBeenCalled();
    } finally {
      await f.safety.close();
    }
  });
  it('rejects a role revoked while a command waits and returns workflow availability honestly', async () => {
    const f = await decisionFixture();
    try {
      f.refreshContext
        .mockResolvedValueOnce(decisionActor())
        .mockResolvedValueOnce(decisionActor('member'));
      await expect(
        f.desk.decide(decisionActor(), f.incident.id, f.command),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(
        (await owner.query('SELECT count(*) FROM policy_approvals')).rows[0]
          .count,
      ).toBe('0');
      const source = { kind: 'detection' as const, id: 'durable-delivery' };
      await f.desk.bindWorkflow(context(), f.incident.id, source);
      const workflow = vi.fn(async () => ({
        phase: 'awaiting_approval' as const,
        exceptionId: f.incident.id,
      }));
      const reads = createDeskServices(
        createTenantDatabase(runtime),
        { refreshContext: f.refreshContext },
        undefined,
        { workflow },
      );
      expect(
        (await reads.progress(decisionActor('member'), f.incident.id)).workflow
          .availability,
      ).toBe('available');
      expect(workflow.mock.calls[0]).toEqual([
        expect.anything(),
        f.incident.id,
        source,
      ]);
      const unavailable = createDeskServices(
        createTenantDatabase(runtime),
        { refreshContext: f.refreshContext },
        undefined,
        {
          workflow: async () => {
            throw new Error('offline');
          },
        },
      );
      expect(
        (await unavailable.progress(context(), f.incident.id)).workflow,
      ).toEqual({ availability: 'unavailable', progress: null });
      await expect(
        f.desk.bindWorkflow(context(otherTenant), f.incident.id, source),
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await f.safety.close();
    }
  });
  it('fences stale diagnosis revisions at dispatch even after approval', async () => {
    const f = await decisionFixture();
    try {
      await f.desk.decide(decisionActor(), f.incident.id, f.command);
      const next = request(randomUUID());
      next.evidence[0]!.observedAt = new Date(now.getTime() + 1).toISOString();
      now = new Date(now.getTime() + 1);
      await services.exceptions.ingest(context(), next);
      await expect(
        f.safety.execution.execute(context(), f.action),
      ).rejects.toThrow('no longer permits dispatch');
      expect(f.perform).not.toHaveBeenCalled();
    } finally {
      await f.safety.close();
    }
  });
  it('closes manually once, removes attention, blocks approved dispatch and preserves recurrence', async () => {
    const f = await decisionFixture();
    try {
      await f.desk.decide(decisionActor(), f.incident.id, f.command);
      const command = {
        commandId: randomUUID(),
        kind: 'close' as const,
        caseRevision: f.command.caseRevision,
        diagnosisRevision: f.command.diagnosisRevision,
        reason: 'Accepted by the team',
        evidenceRefs: [],
      };
      const receipts = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          f.desk.decide(decisionActor(), f.incident.id, command),
        ),
      );
      for (const result of receipts) {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled')
          expect(result.value).toMatchObject({
            id: command.commandId,
            caseRevision: command.caseRevision + 1,
          });
      }
      const progress = await f.desk.progress(decisionActor(), f.incident.id);
      expect(progress.resolution).toMatchObject({
        kind: 'human_disposition',
        actorId: 'approver',
        reason: command.reason,
        evidenceRefs: [],
      });
      expect(progress.state).toBe('resolved');
      expect(
        (await services.cases.get(context(), f.incident.id))!.attention
          .required,
      ).toBe(false);
      for (const view of ['active', 'needs_you'] as const)
        expect(
          (
            await services.cases.list(
              context(),
              caseQuerySchema.parse({ view }),
            )
          ).items.some((i) => i.id === f.incident.id),
        ).toBe(false);
      expect(
        (
          await services.cases.list(
            context(),
            caseQuerySchema.parse({ view: 'history' }),
          )
        ).items.find((i) => i.id === f.incident.id)?.resolution,
      ).toBe('human_disposition');
      expect(
        (await f.desk.review(decisionActor(), f.incident.id))
          .permittedDecisions,
      ).toEqual([]);
      expect(await f.desk.proposal(context(), f.action.id)).toBeNull();
      await expect(
        f.safety.execution.execute(context(), f.action),
      ).rejects.toThrow('no longer permits dispatch');
      expect(f.perform).not.toHaveBeenCalled();
      const timeline = await f.desk.timeline(decisionActor(), f.incident.id, {
        limit: 100,
      });
      expect(
        timeline.items.find((i) => i.type === 'exception.resolved'),
      ).toMatchObject({
        reason: command.reason,
        outcome: 'human_disposition',
        actor: { id: 'approver' },
      });
      expect(
        (
          await owner.query(
            "SELECT count(*) FROM exception_outbox WHERE exception_id=$1 AND document->>'type'='exception.resolved'",
            [f.incident.id],
          )
        ).rows[0].count,
      ).toBe('1');
      await expect(
        f.desk.decide(decisionActor(), f.incident.id, {
          ...command,
          reason: 'Different',
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        f.desk.decide(decisionActor(), f.incident.id, {
          ...command,
          commandId: randomUUID(),
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const old = request(f.action.preconditions.evidenceRefs[0]);
      old.evidence[0]!.observedAt = now.toISOString();
      expect(
        (await services.exceptions.ingest(context(), old)).incident?.id,
      ).toBe(f.incident.id);
      const next = request(randomUUID());
      next.evidence[0]!.observedAt = now.toISOString();
      const successor = (await services.exceptions.ingest(context(), next))
        .incident!;
      expect(successor.id).not.toBe(f.incident.id);
      expect(successor.previousExceptionId).toBe(f.incident.id);
    } finally {
      await f.safety.close();
    }
  });

  it('retains uncertain execution and permits read-only reconciliation after manual closure', async () => {
    const f = await decisionFixture();
    try {
      await f.desk.decide(decisionActor(), f.incident.id, f.command);
      f.perform.mockRejectedValueOnce(new Error('Provider response lost'));
      expect(
        (await f.safety.execution.execute(context(), f.action)).state,
      ).toBe('reconciliation_required');
      const review = await f.desk.review(decisionActor(), f.incident.id);
      await f.desk.decide(decisionActor(), f.incident.id, {
        commandId: randomUUID(),
        kind: 'close',
        caseRevision: review.caseRevision,
        diagnosisRevision: review.diagnosisRevision,
        reason: 'Team accepted the uncertain outcome',
      });
      expect(
        (await f.desk.progress(decisionActor(), f.incident.id)).execution
          ?.state,
      ).toBe('unknown');
      expect(
        (await f.safety.execution.reconcile(context(), f.action.id)).state,
      ).toBe('succeeded');
      expect(f.perform).toHaveBeenCalledTimes(1);
      expect(
        (await f.desk.progress(decisionActor(), f.incident.id)).resolution
          ?.kind,
      ).toBe('human_disposition');
    } finally {
      await f.safety.close();
    }
  });

  it('exposes closure over HTTP with bounded reasons, tenant checks and permission enforcement', async () => {
    const f = await decisionFixture();
    const app = buildApp(
      {},
      {
        desk: f.desk,
        identity: {
          resolveTenant: async (
            credentials: { cookie?: string },
            tenant: string,
          ) =>
            credentials.cookie === 'member=1'
              ? decisionActor('member', 'reader', tenant)
              : decisionActor('admin', 'approver', tenant),
          hasSupportView: () => false,
        } as unknown as IdentityService,
        trustedOrigins: ['http://fixture.test'],
      },
    );
    const command = {
      commandId: randomUUID(),
      kind: 'close',
      caseRevision: f.command.caseRevision,
      diagnosisRevision: f.command.diagnosisRevision,
      reason: 'a'.repeat(1000),
    };
    const url = `/v1/organizations/${tenantId}/exceptions/${f.incident.id}/decisions`;
    const headers = { cookie: 'admin=1', origin: 'http://fixture.test' };
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { ...headers, cookie: 'member=1' },
            payload: command,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: url.replace(tenantId, otherTenant),
            headers,
            payload: command,
          })
        ).statusCode,
      ).toBe(404);
      for (const reason of [' ', 'a'.repeat(1001)])
        expect(
          (
            await app.inject({
              method: 'POST',
              url,
              headers,
              payload: { ...command, reason },
            })
          ).statusCode,
        ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers,
            payload: { ...command, evidenceRefs: ['missing'] },
          })
        ).statusCode,
      ).toBe(422);
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: command,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: command.commandId,
        kind: 'close',
        reason: command.reason,
      });
      expect(
        (
          await app.inject({ method: 'POST', url, headers, payload: command })
        ).json(),
      ).toEqual(response.json());
    } finally {
      await app.close();
      await f.safety.close();
    }
  });

  it('enforces closure authority, tenant scope, evidence ownership and current revisions', async () => {
    const f = await decisionFixture();
    try {
      const command = {
        commandId: randomUUID(),
        kind: 'close' as const,
        caseRevision: f.command.caseRevision,
        diagnosisRevision: f.command.diagnosisRevision,
        reason: 'False positive',
        evidenceRefs: [],
      };
      await expect(
        f.desk.decide(decisionActor('member'), f.incident.id, command),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        f.desk.decide(context(otherTenant), f.incident.id, command),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        f.desk.decide(decisionActor(), f.incident.id, {
          ...command,
          caseRevision: command.caseRevision + 1,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const foreign = request('foreign-evidence', otherTenant);
      foreign.evidence[0]!.observedAt = now.toISOString();
      await services.exceptions.ingest(context(otherTenant), foreign);
      await expect(
        f.desk.decide(decisionActor(), f.incident.id, {
          ...command,
          evidenceRefs: ['foreign-evidence'],
        }),
      ).rejects.toMatchObject({ statusCode: 422 });
      expect(
        (await services.exceptions.get(context(), f.incident.id))!.state,
      ).not.toBe('resolved');
      expect(
        (await owner.query('SELECT count(*) FROM case_commands')).rows[0].count,
      ).toBe('0');
      f.refreshContext
        .mockResolvedValueOnce(decisionActor())
        .mockResolvedValueOnce(decisionActor('member'));
      await expect(
        f.desk.decide(decisionActor(), f.incident.id, command),
      ).rejects.toMatchObject({ statusCode: 403 });
      await f.desk.decide(decisionActor(), f.incident.id, {
        ...command,
        evidenceRefs: f.action.preconditions.evidenceRefs,
      });
    } finally {
      await f.safety.close();
    }
  });

  it('fences an approved proposal when an operator escalates before dispatch', async () => {
    const f = await decisionFixture();
    try {
      await f.desk.decide(decisionActor(), f.incident.id, f.command);
      const request = {
        commandId: randomUUID(),
        kind: 'escalate' as const,
        caseRevision: f.command.caseRevision,
        diagnosisRevision: f.command.diagnosisRevision,
        reason: 'Manual review required',
      };
      await f.desk.decide(decisionActor(), f.incident.id, request);
      await expect(
        f.safety.execution.execute(context(), f.action),
      ).rejects.toThrow('no longer permits dispatch');
      expect(f.perform).not.toHaveBeenCalled();
      expect((await services.cases.get(context(), f.incident.id))!.state).toBe(
        'escalated',
      );
      expect(
        await f.desk.decide(decisionActor(), f.incident.id, request),
      ).toMatchObject({ id: request.commandId });
    } finally {
      await f.safety.close();
    }
  });
  it('serves typed decisions and reconnecting SSE with session rechecks and tenant isolation', async () => {
    const f = await decisionFixture();
    let revoked = false;
    const resolveTenant = vi
      .fn<IdentityService['resolveTenant']>()
      .mockImplementation(async (credentials, tenant) => {
        if (!credentials.cookie || revoked)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
        if (tenant !== tenantId)
          throw new IdentityError(404, 'NOT_FOUND', 'Organization not found');

        return decisionActor();
      });
    const app = buildApp(
      {},
      {
        desk: f.desk,
        identity: {
          resolveTenant,
          hasSupportView: () => false,
        } as unknown as IdentityService,
        trustedOrigins: ['http://fixture.test'],
        eventSettings: { intervalMs: 20, lifetimeMs: 2000 },
      },
    );
    try {
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const client = createApiClient({
        baseUrl: base,
        headers: { cookie: 'fixture=valid', origin: 'http://fixture.test' },
      });
      const params = { organizationId: tenantId, exceptionId: f.incident.id };
      await client.caseDesk.review({ params });
      await client.caseDesk.decide({ params, body: f.command });
      await client.caseDesk.receipt({
        params: { ...params, commandId: f.command.commandId },
      });
      await client.caseDesk.progress({ params });
      await client.caseDesk.timeline({ params, query: { limit: 2 } });
      const path = `${base}/v1/organizations/${tenantId}/exceptions/${f.incident.id}/events`;
      expect((await fetch(path)).status).toBe(401);
      expect(
        (
          await fetch(path.replace(tenantId, otherTenant), {
            headers: { cookie: 'fixture=valid' },
          })
        ).status,
      ).toBe(404);
      const connections = [];
      for (let i = 0; i < 3; i++) {
        const response = await fetch(path, {
          headers: { cookie: 'fixture=valid', 'last-event-id': 'old-cursor' },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        const reader = response.body!.getReader();
        connections.push(reader);
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain(
          'event: resync',
        );
        expect(new TextDecoder().decode(first.value)).toContain(f.incident.id);
      }
      expect(
        (await fetch(path, { headers: { cookie: 'fixture=valid' } })).status,
      ).toBe(429);
      revoked = true;
      for (const reader of connections) {
        let done = false;
        while (!done) done = (await reader.read()).done;
      }
      expect(resolveTenant.mock.calls.length).toBeGreaterThan(8);
      revoked = false;
      const reconnect = await fetch(path, {
        headers: { cookie: 'fixture=valid', 'last-event-id': randomUUID() },
      });
      expect(reconnect.status).toBe(200);
      const reader = reconnect.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        'event: resync',
      );
      await reader.cancel();
    } finally {
      await app.close();
      await f.safety.close();
    }
  });
  it('paginates stable ties and rejects cursors from other filters or tenants', async () => {
    for (let i = 0; i < 4; i++) {
      const value = request(`page-${i}`);
      if (value.input.exceptionClass !== 'sync_failure')
        throw new Error('fixture');
      value.input.facts.connectionId = randomUUID();
      value.input.facts.subjectId = value.input.facts.connectionId;
      value.evidence[0]!.connectionId = value.input.facts.connectionId;
      await services.exceptions.ingest(context(), value);
    }
    const query = caseQuerySchema.parse({ view: 'active', limit: 2 });
    const first = await services.cases.list(context(), query);
    const second = await services.cases.list(context(), {
      ...query,
      cursor: first.nextCursor!,
    });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((x) => x.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(4);
    await expect(
      services.cases.list(context(otherTenant), {
        ...query,
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow('Invalid cursor');
    await expect(
      services.cases.list(context(), {
        ...query,
        view: 'history',
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow('Invalid cursor');
    await owner.query(
      "UPDATE exceptions SET state='escalated',document=jsonb_set(document,'{state}','\"escalated\"') WHERE id=$1",
      [ids[0]],
    );
    const needs = await services.cases.list(
      context(),
      caseQuerySchema.parse({}),
    );
    expect(needs.items.map((x) => x.id)).toEqual([ids[0]]);
    expect(needs.items[0]?.attention.reason).toBe('uncertainty');
  });
  it('filters, sorts, groups and searches issues by catalog conditions', async () => {
    const people = (
      await owner.query<{ user_id: string }>(
        'SELECT user_id FROM workspace_people WHERE tenant_id=$1 ORDER BY user_id',
        [tenantId],
      )
    ).rows.map((row) => row.user_id);
    const reader = (userId: string, id = tenantId) =>
      makeTenantContext(
        { userId, sessionId: 'session' },
        {
          id,
          name: 'Fixture',
          slug: 'fixture',
          dataRegion: 'EU',
          status: 'active',
        },
        builtInMembership(
          { id: 'membership', organizationId: id, userId },
          'owner',
        ),
        randomUUID(),
      );
    const me = reader(people[0]!);
    const providers = ['shopify', 'jtl', 'shopify', null] as const;
    const ids: string[] = [];
    const subjects: string[] = [];
    for (const [i, provider] of providers.entries()) {
      const value = request(`list-${i}`);
      if (value.input.exceptionClass !== 'sync_failure')
        throw new Error('fixture');
      value.input.facts.connectionId = randomUUID();
      value.input.facts.subjectId = value.input.facts.connectionId;
      value.evidence[0]!.connectionId = value.input.facts.connectionId;
      value.evidence[0]!.source = provider
        ? {
            provider,
            resource: 'orders',
            externalId: `order-${i}`,
            scopeKey: '',
          }
        : null;
      subjects.push(value.input.facts.connectionId);
      // Each issue is detected a day after the previous one.
      now = new Date(`2026-09-1${i}T08:00:00.000Z`);
      ids.push(
        (await services.exceptions.ingest(context(), value)).incident!.id,
      );
    }
    now = new Date(corpus.now);
    // The first issue escalates with high severity; the second belongs to the reader.
    await owner.query(
      `UPDATE exceptions SET state='escalated',document=document||'{"state":"escalated","severity":"high"}'::jsonb WHERE id=$1`,
      [ids[0]],
    );
    await owner.query(
      `INSERT INTO case_owners(tenant_id,exception_id,user_id,document)
       VALUES($1,$2,$3::uuid,jsonb_build_object('userId',$3::text,'revision',1,'assignedBy',$3::text,'assignedAt','2026-09-17T08:00:00.000Z'))`,
      [tenantId, ids[1], people[0]],
    );
    const list = (query: Record<string, unknown>, as = me) =>
      services.cases.list(
        as,
        caseQuerySchema.parse({ view: 'active', ...query }),
      );
    const where = (...conditions: unknown[]) =>
      JSON.stringify({ match: 'all', conditions });
    const found = async (query: Record<string, unknown>, as = me) =>
      (await list(query, as)).items.map((item) => item.id).sort();
    const sorted = (...values: (string | undefined)[]) =>
      values.filter((value): value is string => !!value).sort();

    expect(
      await found({
        where: where({ field: 'source', op: 'any_of', value: ['shopify'] }),
      }),
    ).toEqual(sorted(ids[0], ids[2]));
    expect(
      await found({ where: where({ field: 'source', op: 'empty' }) }),
    ).toEqual([ids[3]]);
    expect(
      await found({
        where: where({ field: 'source', op: 'none_of', value: ['shopify'] }),
      }),
    ).toEqual(sorted(ids[1], ids[3]));
    expect(
      await found({
        where: where({
          field: 'owner',
          op: 'any_of',
          value: [{ dynamic: 'me' }],
        }),
      }),
    ).toEqual([ids[1]]);
    expect(
      await found(
        {
          where: where({
            field: 'owner',
            op: 'any_of',
            value: [{ dynamic: 'me' }],
          }),
        },
        reader(people[1]!),
      ),
    ).toEqual([]);
    expect(
      await found({ where: where({ field: 'owner', op: 'empty' }) }),
    ).toEqual(sorted(ids[0], ids[2], ids[3]));
    expect(
      await found({
        where: where(
          { field: 'attention', op: 'any_of', value: ['uncertainty'] },
          { field: 'severity', op: 'any_of', value: ['high'] },
        ),
      }),
    ).toEqual([ids[0]]);
    expect(
      await found({
        where: JSON.stringify({
          match: 'any',
          conditions: [
            { field: 'state', op: 'any_of', value: ['escalated'] },
            { field: 'owner', op: 'not_empty' },
          ],
        }),
      }),
    ).toEqual(sorted(ids[0], ids[1]));
    expect(
      await found({
        where: where({
          field: 'detected',
          op: 'between',
          value: { from: '2026-09-11', to: '2026-09-12' },
        }),
        timeZone: 'Europe/Berlin',
      }),
    ).toEqual(sorted(ids[1], ids[2]));
    expect(
      await found({
        where: where({
          field: 'subjectType',
          op: 'any_of',
          value: ['connection'],
        }),
      }),
    ).toEqual(sorted(...ids));

    // Freshness follows the investigation's validity: without one it is unknown, with one it
    // is fresh until the validity ends and stale afterwards, never fresh.
    await services.diagnoses.run(context(), ids[2]!);
    const validUntil = new Date(now.getTime() + 3_600_000).toISOString();
    await owner.query(
      `UPDATE exception_diagnoses SET document=jsonb_set(document,'{provenance,validUntil}',to_jsonb($2::text))
       WHERE exception_id=$1 AND document->>'status'='ready'`,
      [ids[2], validUntil],
    );
    const freshness = async (value: string) =>
      found({
        where: where({ field: 'freshness', op: 'any_of', value: [value] }),
      });
    const byId = async () =>
      new Map(
        (await list({ limit: 25 })).items.map((item) => [
          item.id,
          item.freshness,
        ]),
      );
    for (const value of ['fresh', 'stale', 'unknown'])
      expect(await freshness(value)).toEqual(
        [...(await byId()).entries()]
          .filter(([, state]) => state === value)
          .map(([id]) => id)
          .sort(),
      );
    expect(await freshness('fresh')).toEqual([ids[2]]);
    {
      const read = now;
      now = new Date(Date.parse(validUntil) + 1000);
      try {
        expect(await freshness('fresh')).toEqual([]);
        expect(await freshness('stale')).toEqual([ids[2]]);
        expect((await byId()).get(ids[2]!)).toBe('stale');
        expect(
          await found({
            where: where({
              field: 'diagnosis',
              op: 'any_of',
              value: ['insufficient_evidence'],
            }),
          }),
        ).toEqual([ids[2]]);
      } finally {
        now = read;
      }
    }

    // Sorting: detection either way; waiting time puts issues that wait on nobody last.
    const order = async (query: Record<string, unknown>) =>
      (await list(query)).items.map((item) => item.id);
    expect(await order({ sort: 'detected' })).toEqual([...ids].reverse());
    expect(await order({ sort: 'detected', direction: 'asc' })).toEqual(ids);
    for (const direction of ['asc', 'desc'] as const) {
      const waiting = (
        await list({ sort: 'waitingSince', direction })
      ).items.map((item) => item.attention.requestedAt);
      const since = waiting.filter((at): at is string => at !== null);
      expect(since.length).toBeGreaterThan(0);
      expect(waiting).toEqual([
        ...since.sort((a, b) =>
          direction === 'asc' ? a.localeCompare(b) : b.localeCompare(a),
        ),
        ...waiting.filter((at) => at === null),
      ]);
    }
    expect((await order({}))[0]).toBe(ids[0]);

    // Search matches summaries and records, with wildcards taken literally.
    expect(await found({ q: subjects[1]!.slice(4, 20) })).toEqual([ids[1]]);
    expect(await found({ q: 'CONNECTION READ' })).toEqual(sorted(...ids));
    expect(await found({ q: '%' })).toEqual([]);

    // Groups carry exact counts, their first rows and a cursor for the rest.
    const grouped = await list({ group: 'source', groupLimit: 1 });
    expect(grouped.groups?.map((group) => [group.key, group.count])).toEqual([
      ['jtl', 1],
      ['shopify', 2],
      [null, 1],
    ]);
    expect(grouped.totalCount).toBe(4);
    const shopify = grouped.groups![1]!;
    expect(shopify.itemIds).toHaveLength(1);
    const rest = await list({
      group: 'source',
      groupKey: '"shopify"',
      cursor: shopify.nextCursor!,
      limit: 10,
    });
    expect(
      sorted(...shopify.itemIds, ...rest.items.map((item) => item.id)),
    ).toEqual(sorted(ids[0], ids[2]));
    expect(rest.nextCursor).toBeNull();
    expect(
      (await list({ group: 'owner' })).groups?.map((group) => group.key),
    ).toEqual([people[0], null]);
    expect(
      (await list({ group: 'state' })).groups?.map((group) => group.key),
    ).toEqual(['detected', 'escalated']);

    // Cursors continue only the same query of the same reader in the same workspace.
    const pages: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ sort: 'detected', limit: 1, cursor });
      pages.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pages).toEqual([...ids].reverse());
    const first = await list({ sort: 'detected', limit: 1 });
    for (const [query, as] of [
      [{ sort: 'lastActivity', limit: 1 }, me],
      [{ sort: 'detected', limit: 1, q: 'connection' }, me],
      [
        {
          sort: 'detected',
          limit: 1,
          where: where({ field: 'owner', op: 'empty' }),
        },
        me,
      ],
      [{ sort: 'detected', limit: 1 }, reader(people[1]!)],
      [{ sort: 'detected', limit: 1 }, reader(people[0]!, otherTenant)],
    ] as const)
      await expect(
        list({ ...query, cursor: first.nextCursor! }, as),
      ).rejects.toThrow('Invalid cursor');
    expect(
      await found(
        { where: where({ field: 'source', op: 'any_of', value: ['shopify'] }) },
        reader(people[0]!, otherTenant),
      ),
    ).toEqual([]);

    const app = buildApp(
      {},
      {
        cases: services.cases,
        identity: {
          hasSupportView: () => false,
          resolveTenant: async () => me,
        } as unknown as IdentityService,
      },
    );
    try {
      const refused = await app.inject(
        `/v1/organizations/${tenantId}/exceptions?view=active&where=${encodeURIComponent(where({ field: 'summary', op: 'contains', value: 'x' }))}`,
      );
      expect(refused.statusCode).toBe(400);
      expect(refused.json().message).toMatch(/^Condition 1: /);
      const ungroupable = await app.inject(
        `/v1/organizations/${tenantId}/exceptions?view=active&group=detected`,
      );
      expect(ungroupable.statusCode).toBe(400);
      const accepted = await app.inject(
        `/v1/organizations/${tenantId}/exceptions?view=active&group=class&where=${encodeURIComponent(where({ field: 'class', op: 'any_of', value: ['sync_failure'] }))}`,
      );
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json().groups[0]).toMatchObject({
        key: 'sync_failure',
        count: 4,
      });
    } finally {
      await app.close();
    }
  });
  it('filters, sorts, groups and searches Needs you while counts keep matching the queue', async () => {
    const people = (
      await owner.query<{ user_id: string }>(
        'SELECT user_id FROM workspace_people WHERE tenant_id=$1 ORDER BY user_id',
        [tenantId],
      )
    ).rows.map((row) => row.user_id);
    const reader = (userId: string, id = tenantId) =>
      makeTenantContext(
        { userId, sessionId: 'session' },
        {
          id,
          name: 'Fixture',
          slug: 'fixture',
          dataRegion: 'EU',
          status: 'active',
        },
        builtInMembership(
          { id: 'membership', organizationId: id, userId },
          'owner',
        ),
        randomUUID(),
      );
    const me = reader(people[0]!);
    // One escalated issue needs review; the owners present three more decisions.
    const value = request('needs-you-case');
    const incident = (await services.exceptions.ingest(context(), value))
      .incident!;
    await owner.query(
      `UPDATE exceptions SET state='escalated',document=document||'{"state":"escalated"}'::jsonb WHERE id=$1`,
      [incident.id],
    );
    const at = (hours: number) =>
      new Date(Date.parse(corpus.now) + hours * 3_600_000).toISOString();
    const decision = (
      id: string,
      input: {
        title: string;
        domain: 'procurement' | 'operations' | 'inventory';
        reason: 'approval' | 'manual_intervention';
        impact: 'high' | 'low' | 'unknown';
        requestedAt: string;
        deadline: string | null;
        cause: string;
      },
    ) => ({
      id,
      kind: 'human_task' as const,
      reason: input.reason,
      domain: input.domain,
      title: input.title,
      why: 'Fixture',
      consequences: [],
      change: [],
      impact: { level: input.impact, text: null },
      requestedAt: input.requestedAt,
      deadline: input.deadline,
      requesterId: null,
      evidence: { observedAt: null, validUntil: null },
      response: 'investigate' as const,
      subject: { label: 'Fixture', detail: null },
      record: null,
      owner: {
        kind: 'human_task' as const,
        definitionId: 'fixture',
        runId: randomUUID(),
        stepId: id,
      },
      group: { key: input.cause, label: input.cause },
    });

    type DecisionProvider = Parameters<
      typeof createDecisionQueue
    >[1]['providers'][number];

    const owned: DecisionProvider = {
      id: 'tasks',
      label: 'Tasks',
      pending: async () => [
        decision('task:a', {
          title: 'Approve draft for Acme',
          domain: 'procurement',
          reason: 'approval',
          impact: 'high',
          requestedAt: at(-5),
          deadline: at(10),
          cause: 'drafts',
        }),
        decision('task:b', {
          title: 'Count stock in Berlin',
          domain: 'inventory',
          reason: 'manual_intervention',
          impact: 'low',
          requestedAt: at(-30),
          deadline: null,
          cause: 'counts',
        }),
        decision('task:c', {
          title: 'Approve draft for Beta 100%',
          domain: 'procurement',
          reason: 'approval',
          impact: 'unknown',
          requestedAt: at(-1),
          deadline: at(2),
          cause: 'drafts',
        }),
      ],
    };
    const failing: DecisionProvider = {
      id: 'broken',
      label: 'Broken owner',
      pending: async () => {
        throw new Error('unavailable');
      },
    };
    const queue = createDecisionQueue(createTenantDatabase(runtime), {
      cases: caseDecisionQuery,
      providers: [owned, failing],
      refreshContext: async (actor) => actor,
      now: () => new Date(corpus.now),
    });
    await owner.query(
      `INSERT INTO decision_assignments(tenant_id,decision_id,assignee_id,assigned_by,assigned_at,revision)
       VALUES($1,'task:b',$2,$2,now(),1)`,
      [tenantId, people[0]],
    );
    const list = (query: Record<string, unknown>, as = me) =>
      queue.list(as, decisionQuerySchema.parse(query));
    const where = (...conditions: unknown[]) =>
      JSON.stringify({ match: 'all', conditions });
    const ids = async (query: Record<string, unknown>, as = me) =>
      (await list(query, as)).items.map((item) => item.id);
    const caseId = `case:${incident.id}`;

    const all = await list({});
    expect(all.items.map((item) => item.id).sort()).toEqual(
      [caseId, 'task:a', 'task:b', 'task:c'].sort(),
    );
    expect(all.sources.find((source) => source.id === 'broken')?.state).toBe(
      'unavailable',
    );
    const filtered = await list({
      where: where({ field: 'domain', op: 'any_of', value: ['procurement'] }),
    });
    expect(filtered.items.map((item) => item.id).sort()).toEqual([
      'task:a',
      'task:c',
    ]);
    expect(filtered.totalCount).toBe(2);
    // Counts describe the whole queue, as Home and the sidebar show it.
    expect(filtered.counts).toEqual(all.counts);
    expect(all.counts.views.all).toBe(4);
    expect(
      await ids({
        where: where({
          field: 'owner',
          op: 'any_of',
          value: [{ dynamic: 'me' }],
        }),
      }),
    ).toEqual(['task:b']);
    expect(
      await ids(
        {
          where: where({
            field: 'owner',
            op: 'any_of',
            value: [{ dynamic: 'me' }],
          }),
        },
        reader(people[1]!),
      ),
    ).toEqual([]);
    expect(
      (await ids({ where: where({ field: 'owner', op: 'empty' }) })).sort(),
    ).toEqual([caseId, 'task:a', 'task:c'].sort());
    expect(
      await ids({
        where: where({
          field: 'deadline',
          op: 'between',
          value: { from: null, to: at(5) },
        }),
      }),
    ).toEqual(['task:c']);
    expect(
      (await ids({ where: where({ field: 'deadline', op: 'empty' }) })).sort(),
    ).toEqual([caseId, 'task:b'].sort());
    expect(
      await ids({
        where: where({ field: 'impact', op: 'any_of', value: ['unknown'] }),
      }),
    ).toEqual(['task:c']);
    expect(
      await ids({
        where: where({
          field: 'requested',
          op: 'within_last',
          value: { amount: 0, unit: 'day' },
        }),
        timeZone: 'UTC',
      }),
    ).toEqual(expect.arrayContaining(['task:c']));
    // High impact ranks before an unknown impact whose deadline is hours away.
    expect(await ids({ q: 'APPROVE DRAFT' })).toEqual(['task:a', 'task:c']);
    expect(await ids({ q: '100%' })).toEqual(['task:c']);
    expect(await ids({ q: '%' })).toEqual(['task:c']);

    // Sorting: a deadline sort keeps decisions without one last in both directions.
    const deadlines = await ids({ sort: 'deadline' });
    expect(deadlines.slice(0, 2)).toEqual(['task:c', 'task:a']);
    const latest = await ids({ sort: 'deadline', direction: 'desc' });
    expect(latest.slice(0, 2)).toEqual(['task:a', 'task:c']);
    expect(latest.slice(2).sort()).toEqual([caseId, 'task:b'].sort());
    expect((await ids({ sort: 'requested' }))[0]).toBe('task:b');

    // Groups by cause: exact counts, first rows and a page link within the group.
    const causes = await list({ group: 'cause', groupLimit: 1 });
    const drafts = causes.groups?.find((group) => group.key === 'drafts');
    expect(drafts).toMatchObject({ count: 2, complete: false });
    expect(drafts?.itemIds).toEqual(['task:a']);
    const more = await list({
      group: 'cause',
      groupKey: '"drafts"',
      cursor: drafts!.nextCursor!,
    });
    expect(more.items.map((item) => item.id)).toEqual(['task:c']);
    expect(more.nextCursor).toBeNull();
    expect(
      (await list({ group: 'reason' })).groups?.map((group) => group.key),
    ).toEqual(['approval', 'manual_intervention', 'uncertainty']);
    expect(
      (await list({ group: 'owner' })).groups?.map((group) => [
        group.key,
        group.count,
      ]),
    ).toEqual([
      [people[0], 1],
      [null, 3],
    ]);

    // Page links continue only the same query of the same reader.
    const first = await list({ limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const second = await list({ limit: 1, cursor: first.nextCursor! });
    expect(second.offset).toBe(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    for (const [query, as] of [
      [{ limit: 1, q: 'draft' }, me],
      [{ limit: 1, sort: 'deadline' }, me],
      [{ limit: 1, where: where({ field: 'owner', op: 'empty' }) }, me],
      [{ limit: 1 }, reader(people[1]!)],
    ] as const)
      await expect(
        list({ ...query, cursor: first.nextCursor! }, as),
      ).rejects.toThrow('no longer matches');
    await expect(
      list({ where: where({ field: 'title', op: 'contains', value: 'x' }) }),
    ).rejects.toThrow('cannot be filtered');
    await expect(list({ group: 'title' })).rejects.toThrow('cannot be grouped');

    // Another workspace never sees this workspace's issues or assignments.
    const other = await list({}, reader(people[0]!, otherTenant));
    expect(other.items.map((item) => item.id)).not.toContain(caseId);
    expect(
      await ids(
        {
          where: where({
            field: 'owner',
            op: 'any_of',
            value: [{ dynamic: 'me' }],
          }),
        },
        reader(people[0]!, otherTenant),
      ),
    ).toEqual([]);
    await owner.query('DELETE FROM decision_assignments WHERE tenant_id=$1', [
      tenantId,
    ]);
  });
  it('limits the case reader role to scoped reads', async () => {
    const incident = (await services.exceptions.ingest(context(), request()))
      .incident!;
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE luma_case_reader');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [
        otherTenant,
      ]);
      expect((await client.query('SELECT id FROM exceptions')).rows).toEqual(
        [],
      );
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [
        tenantId,
      ]);
      expect((await client.query('SELECT id FROM exceptions')).rows).toEqual([
        { id: incident.id },
      ]);
      await expect(
        client.query("UPDATE exceptions SET state='failed'"),
      ).rejects.toThrow('permission denied');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('atomically deduplicates concurrent deliveries and new delivery IDs', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        services.exceptions.ingest(context(), {
          ...request(),
          key: `delivery-${i}`,
        }),
      ),
    );
    expect(new Set(results.map((r) => r.incident?.id)).size).toBe(1);
    expect(
      (await services.exceptions.list(context()))[0]?.occurrenceCount,
    ).toBe(1);
    expect(
      await services.exceptions.evidence(context(), results[0]!.incident!.id),
    ).toHaveLength(1);
    const next = await services.exceptions.ingest(
      context(),
      request('event-2'),
    );
    expect(next.incident?.occurrenceCount).toBe(2);
    expect(next.incident?.id).toBe(results[0]?.incident?.id);
  });
  it('rejects conflicting immutable source facts and rolls back all writes', async () => {
    await services.exceptions.ingest(context(), request());
    const changed = request();
    changed.evidence[0]!.facts = { errorCode: 'timeout' };
    changed.configuration.version = 'new-version';
    await expect(
      services.exceptions.ingest(context(), changed),
    ).rejects.toThrow('conflict');
    expect(
      (await owner.query('SELECT * FROM exception_configurations')).rowCount,
    ).toBe(1);
    const factsChanged = request();
    if (factsChanged.input.exceptionClass === 'sync_failure')
      factsChanged.input.facts.errorCode = 'timeout';
    await expect(
      services.exceptions.ingest(context(), factsChanged),
    ).rejects.toThrow('conflict');
    expect(
      (await services.exceptions.list(context()))[0]?.occurrenceCount,
    ).toBe(1);
  });
  it('isolates tenants in service queries, foreign keys and direct RLS access', async () => {
    const first = await services.exceptions.ingest(context(), request());
    const second = await services.exceptions.ingest(
      context(otherTenant),
      request('event-1', otherTenant),
    );
    expect(first.incident?.id).not.toBe(second.incident?.id);
    expect(
      await services.exceptions.evidence(
        context(otherTenant),
        first.incident!.id,
      ),
    ).toEqual([]);
    expect((await runtime.query('SELECT * FROM exceptions')).rows).toEqual([]);
    const mixed = request('mixed');
    mixed.evidence[0]!.tenantId = otherTenant;
    expect(
      (await services.exceptions.ingest(context(), mixed)).decision.decision,
    ).toBe('reject');
    await expect(
      owner.query(
        'INSERT INTO exception_evidence(tenant_id,exception_id,evidence_key,fingerprint) VALUES($1,$2,$3,$4)',
        [
          otherTenant,
          first.incident!.id,
          'missing',
          first.incident!.fingerprint,
        ],
      ),
    ).rejects.toThrow();
    await expect(
      runtime.query('DELETE FROM exception_sources'),
    ).rejects.toThrow('permission denied');
  });
  it('retains active incidents for clear/defer and escalates persistent uncertainty', async () => {
    const initial = await services.exceptions.ingest(context(), request());
    const healthy = request('success');
    if (healthy.input.exceptionClass === 'sync_failure')
      Object.assign(healthy.input.facts, {
        status: 'success',
        errorCode: null,
        scanComplete: true,
      });
    const clear = await services.exceptions.ingest(context(), healthy);
    expect(clear.decision.decision).toBe('clear');
    expect(clear.incident?.state).toBe('detected');
    const uncertain = request('uncertain');
    if (uncertain.input.exceptionClass === 'sync_failure')
      uncertain.input.facts.errorCode = 'internal';
    expect(
      (await services.exceptions.ingest(context(), uncertain)).reviewRequired,
    ).toBe(false);
    now = new Date(now.getTime() + 1800_000);
    const deferred = await services.exceptions.ingest(context(), uncertain);
    expect(deferred.reviewRequired).toBe(true);
    expect(deferred.incident?.state).toBe('escalated');
    const repeat = await services.exceptions.ingest(
      context(),
      request('event-2'),
    );
    expect(repeat.incident?.id).toBe(initial.incident?.id);
    expect(repeat.incident?.state).toBe('escalated');
    expect(repeat.incident?.occurrenceCount).toBe(2);
  });
  it('records stock waiting for sync without escalating it and clears the wait on a decision', async () => {
    const sku = randomUUID(),
      pool = randomUUID(),
      store = randomUUID();
    const stock = (event: string, facts: Record<string, unknown>) => {
      const refs = [`${event}-left`, `${event}-right`];

      return {
        key: event,
        input: parseInput('inventory_mismatch', {
          ...corpus.bases.inventory_mismatch,
          tenantId,
          evidenceTenantId: tenantId,
          evidenceRefs: refs,
          subjectId: sku,
          canonicalLocationId: pool,
          connectionIds: [connectionId, store],
          leftObservedAt: now.toISOString(),
          rightObservedAt: now.toISOString(),
          leftAvailable: '100',
          rightAvailable: '101',
          ...facts,
        }),
        configuration: structuredClone(defaultConfiguration),
        evidence: refs.map((key) => ({
          key,
          tenantId,
          connectionId: null,
          observedAt: now.toISOString(),
          sourceUpdatedAt: null,
          adapterVersion: 'fixture-v1',
          schemaVersion: 1 as const,
          source: null,
          facts: {},
        })),
      } satisfies DetectionRequest;
    };
    const waits = async () =>
      (
        await owner.query(
          'SELECT subject_id,scope,mismatch_since,wait_until FROM exception_pending_sync WHERE tenant_id=$1',
          [tenantId],
        )
      ).rows;

    // Each sale opens a new gap that syncs; the waits never add up to uncertainty.
    for (const step of [0, 1, 2, 3]) {
      now = new Date(Date.parse(corpus.now) + step * 1_800_000);
      const result = await services.exceptions.ingest(
        context(),
        stock(`gap-${step}`, { mismatchSince: now.toISOString() }),
      );
      expect(result).toMatchObject({
        decision: { decision: 'defer', reason: 'propagation_pending' },
        incident: null,
        reviewRequired: false,
      });
    }
    expect(await waits()).toEqual([
      {
        subject_id: sku,
        scope: [pool, ...[connectionId, store].sort()],
        mismatch_since: now,
        wait_until: new Date(now.getTime() + 1_800_000),
      },
    ]);
    expect(
      (await runtime.query('SELECT 1 FROM exception_pending_sync')).rowCount,
    ).toBe(0);

    // A gap that outlasts the window is raised and is no longer shown as waiting.
    now = new Date(now.getTime() + 1_801_000);
    const raised = await services.exceptions.ingest(
      context(),
      stock('gap-late', {
        mismatchSince: new Date(now.getTime() - 1_801_000).toISOString(),
      }),
    );
    expect(raised.decision).toMatchObject({ decision: 'detect' });
    expect(await waits()).toEqual([]);
  });
  it('emits a review task without inventing an incident for prolonged uncertainty', async () => {
    const uncertain = request();
    if (uncertain.input.exceptionClass === 'sync_failure')
      uncertain.input.facts.errorCode = 'internal';
    await services.exceptions.ingest(context(), uncertain);
    now = new Date(now.getTime() + 1800_000);
    const result = await services.exceptions.ingest(context(), uncertain);
    expect(result.incident).toBeNull();
    expect(result.reviewRequired).toBe(true);
    expect(
      (
        await owner.query(
          "SELECT * FROM exception_outbox WHERE document->>'type'='exception.review_required'",
        )
      ).rowCount,
    ).toBe(1);
  });
  it('deduplicates failed incidents and versions thresholds without splitting incidents', async () => {
    const initial = await services.exceptions.ingest(context(), request());
    await owner.query(
      "UPDATE exceptions SET state='failed',document=jsonb_set(document,'{state}','\"failed\"') WHERE id=$1",
      [initial.incident!.id],
    );
    const next = request('event-2');
    next.configuration.version = `${defaultConfiguration.version}-next`;
    next.configuration.thresholds.freshnessSeconds = 120;
    const result = await services.exceptions.ingest(context(), next);
    expect(result.incident?.id).toBe(initial.incident?.id);
    expect(result.incident?.state).toBe('failed');
    expect(result.incident?.configVersion).toBe(
      `${defaultConfiguration.version}-next`,
    );
    const invalid = request('event-3');
    invalid.configuration.thresholds.freshnessSeconds = 1;
    await expect(
      services.exceptions.ingest(context(), invalid),
    ).rejects.toThrow('conflict');
  });
  it('links recurrence after an audited human disposition but never reopens on replay', async () => {
    const initial = await services.exceptions.ingest(context(), request());
    await services.exceptions.resolve(context(), initial.incident!.id, {
      kind: 'human_disposition',
      reason: 'Operator repaired and reviewed the connection',
      evidenceRefs: ['event-1'],
    });
    const replay = await services.exceptions.ingest(context(), request());
    expect(replay.incident?.state).toBe('resolved');
    const next = await services.exceptions.ingest(
      context(),
      request('event-2'),
    );
    expect(next.incident?.previousExceptionId).toBe(initial.incident!.id);
    expect(next.incident?.occurrenceCount).toBe(1);
    expect(
      (
        await owner.query(
          "SELECT * FROM exception_outbox WHERE document->>'type'='exception.resolved'",
        )
      ).rowCount,
    ).toBe(1);
  });
  it('persists all four classes from real JTL/Shopify adapter snapshots and durable events', async () => {
    now = new Date('2026-09-17T15:00:00Z');
    const fixture = await detectionFixtures(context(), now);
    const left = fixture.jtlInventory.items[0]!,
      right = fixture.shopifyInventory.items[1]!;
    const inventoryInput = {
      left,
      right,
      mapping: {
        tenantId,
        version: 'mapping-v1',
        publishedAt: corpus.now,
        skuId: randomUUID(),
        locationId: randomUUID(),
        left: {
          source: left.source,
          sku: left.data.sku,
          location: left.data.location,
        },
        right: {
          source: right.source,
          sku: right.data.sku,
          location: right.data.location,
        },
        authority: 'left' as const,
        sellingSource: 'right' as const,
      },
      complete: true,
      projectionCurrent: true,
      configuration: defaultConfiguration,
    };
    const inventory = await services.pipeline.inventory(
      context(),
      inventoryInput,
    );
    expect(inventory.decision).toEqual({
      decision: 'detect',
      severity: 'high',
      reason: 'oversell_risk',
    });
    expect(
      await services.exceptions.evidence(context(), inventory.incident!.id),
    ).toHaveLength(3);
    expect(
      (await services.pipeline.inventory(context(), inventoryInput)).incident
        ?.occurrenceCount,
    ).toBe(1);
    for (const observation of [
      fixture.jtlFulfillment.items.find((o) => o.data.status === 'processing')!,
      fixture.shopifyFulfillment.items.find(
        (o) => o.data.status === 'processing',
      )!,
    ]) {
      expect(observation).toBeDefined();
      const eligibilityEvidence: Evidence = {
        key: randomUUID(),
        tenantId,
        connectionId: observation.source.connectionId,
        observedAt: now.toISOString(),
        sourceUpdatedAt: null,
        source: null,
        adapterVersion: 'eligibility-v1',
        schemaVersion: 1,
        facts: { eligibility: 'eligible' },
      };
      const result = await services.pipeline.fulfillment(context(), {
        observation,
        mapping: {
          tenantId,
          version: 'mapping-v1',
          publishedAt: corpus.now,
          fulfillmentId: randomUUID(),
          source: observation.source,
          order: observation.data.order,
          lines: observation.data.lines.map((line) => line.orderLine),
        },
        complete: true,
        eligibility: 'eligible',
        eligibilityEvidence,
        configuration: defaultConfiguration,
      });
      expect(result.decision).toEqual({
        decision: 'detect',
        severity: 'medium',
        reason: 'progress_timeout',
      });
    }
    const scan = await services.pipeline.scan(context(), {
      event: request('failed-scan').evidence[0]!,
      connectionId,
      capability: 'inventory.read',
      active: true,
      status: 'failed',
      error: { code: 'authentication', effect: 'none', retry: 'never' },
      firstFailureAt: now.toISOString(),
      retryExhausted: false,
      scanComplete: false,
      configuration: defaultConfiguration,
    });
    expect(scan.decision.decision).toBe('detect');
    expect(
      await services.exceptions.evidence(context(), inventory.incident!.id),
    ).toHaveLength(3);
    const workflow = await services.pipeline.workflow(context(), {
      event: {
        ...request('worker-interrupted').evidence[0]!,
        connectionId: null,
      },
      facts: {
        subjectId: randomUUID(),
        runId: randomUUID(),
        stepKey: 'inventory-sync',
        attempt: 1,
        status: 'interrupted',
        durable: true,
        retryExhausted: false,
        effect: 'unknown',
        executionId: randomUUID(),
        errorCode: 'worker_lost',
      },
      configuration: defaultConfiguration,
    });
    expect(workflow.decision).toEqual({
      decision: 'detect',
      severity: 'high',
      reason: 'reconciliation_required',
    });
    expect(
      new Set(
        (await services.exceptions.list(context())).map(
          (item) => item.exceptionClass,
        ),
      ).size,
    ).toBe(4);
    const cases = await services.cases.list(
      context(),
      caseQuerySchema.parse({ view: 'active' }),
    );
    expect(new Set(cases.items.map((item) => item.class)).size).toBe(4);
    for (const item of cases.items) {
      expect(
        caseDetailSchema.safeParse(await services.cases.get(context(), item.id))
          .success,
      ).toBe(true);
    }
  });

  function verification(incident: Incident): VerificationResult {
    return {
      reason: 'Complete authoritative reread proves the postcondition',
      outcome: 'passed',
      complete: true,
      authoritative: true,
      evidence: [
        {
          ...request('verification-1').evidence[0]!,
          facts: { scanComplete: true, checkpointAdvanced: true },
        },
      ],
      bindings: [
        {
          evidenceKey: 'verification-1',
          exceptionClass: incident.exceptionClass,
          subject: structuredClone(incident.subject),
          postcondition: 'complete_scan_checkpoint_advanced',
        },
      ],
    };
  }

  it('rejects caller-authored verified dispositions and fails closed without an evaluator', async () => {
    const incident = (await services.exceptions.ingest(context(), request()))
      .incident!;
    const forged = {
      ...verification(incident),
      kind: 'verification',
      fingerprint: incident.fingerprint,
      configVersion: incident.configVersion,
      evaluatorVersion: 'claimed',
      evidenceRefs: ['verification-1'],
    };
    expect(() =>
      services.exceptions.resolve(
        context(),
        incident.id,
        forged as unknown as Parameters<typeof services.exceptions.resolve>[2],
      ),
    ).toThrow();
    const unconfigured = createDetectionServices(runtimeUrl, () => now);
    try {
      await expect(
        unconfigured.exceptions.verify(context(), incident.id),
      ).rejects.toThrow('not configured');
    } finally {
      await unconfigured.close();
    }
    expect(evaluate).not.toHaveBeenCalled();
    expect((await services.exceptions.list(context()))[0]?.state).toBe(
      'detected',
    );
  });
  it.each([
    'class',
    'subject',
    'scope',
    'rule',
    'postcondition',
    'connection',
    'tenant',
  ] as const)(
    'rejects evaluator evidence with a different %s',
    async (field) => {
      const incident = (await services.exceptions.ingest(context(), request()))
        .incident!;
      const proof = verification(incident),
        binding = proof.bindings[0]!;
      if (field === 'class') binding.exceptionClass = 'workflow_failure';
      if (field === 'subject') binding.subject.subjectId = randomUUID();
      if (field === 'scope') binding.subject.scope = ['orders.read'];
      if (field === 'rule') binding.subject.ruleIdentity = 'another-rule';
      if (field === 'postcondition')
        binding.postcondition = 'equivalent_inventory_agrees';
      if (field === 'connection')
        proof.evidence[0]!.connectionId = randomUUID();
      if (field === 'tenant') proof.evidence[0]!.tenantId = otherTenant;
      evaluate.mockResolvedValue(proof);
      await expect(
        services.exceptions.verify(context(), incident.id),
      ).rejects.toThrow();
      const attempts = await owner.query(
        "SELECT document FROM exception_outbox WHERE exception_id=$1 AND document->>'type'='exception.verification_attempt' AND document->>'phase'='completed'",
        [incident.id],
      );
      expect(attempts.rows.map((row) => row.document)).toEqual([
        expect.objectContaining(
          field === 'tenant'
            ? { failureCode: 'evaluation_failed' }
            : {
                outcome: 'passed',
                accepted: false,
                failureCode: 'resolution_rejected',
              },
        ),
      ]);
      expect((await services.exceptions.list(context()))[0]?.state).toBe(
        'detected',
      );
      expect(
        (
          await owner.query(
            "SELECT * FROM exception_outbox WHERE document->>'type'='exception.resolved'",
          )
        ).rowCount,
      ).toBe(0);
    },
  );
  it('rejects verification if detection changes during the authoritative read', async () => {
    const incident = (await services.exceptions.ingest(context(), request()))
      .incident!;
    evaluate.mockImplementation(async () => {
      await services.exceptions.ingest(context(), request('event-2'));

      return verification(incident);
    });
    await expect(
      services.exceptions.verify(context(), incident.id),
    ).rejects.toThrow('changed during verification');
    const attempts = await owner.query(
      "SELECT document FROM exception_outbox WHERE exception_id=$1 AND document->>'type'='exception.verification_attempt' AND document->>'phase'='completed'",
      [incident.id],
    );
    expect(attempts.rows.map((row) => row.document)).toEqual([
      expect.objectContaining({
        outcome: 'passed',
        accepted: false,
        failureCode: 'resolution_rejected',
      }),
    ]);
    expect(
      (await services.exceptions.list(context()))[0]?.occurrenceCount,
    ).toBe(2);
    expect((await services.exceptions.list(context()))[0]?.state).toBe(
      'detected',
    );
  });
  it('requires fresh independent passed verification and keeps uncertain effects unresolved', async () => {
    const incident = (await services.exceptions.ingest(context(), request()))
      .incident!;
    const proof = verification(incident);
    for (const change of [
      { outcome: 'inconclusive' as const },
      { outcome: 'failed' as const },
      { complete: false },
      { authoritative: false },
    ]) {
      evaluate.mockResolvedValue({ ...proof, ...change });
      expect(await services.exceptions.verify(context(), incident.id)).toBe(
        false,
      );
    }
    evaluate.mockResolvedValue({
      ...proof,
      evidence: request().evidence,
      bindings: [{ ...proof.bindings[0]!, evidenceKey: 'event-1' }],
    });
    expect(await services.exceptions.verify(context(), incident.id)).toBe(
      false,
    );
    expect((await services.exceptions.list(context()))[0]?.state).toBe(
      'detected',
    );
    now = new Date(now.getTime() + 301_000);
    evaluate.mockResolvedValue(proof);
    expect(await services.exceptions.verify(context(), incident.id)).toBe(
      false,
    );
    evaluate.mockResolvedValue({
      ...proof,
      evidence: [
        {
          ...proof.evidence[0]!,
          key: 'verification-2',
          observedAt: now.toISOString(),
        },
      ],
      bindings: [{ ...proof.bindings[0]!, evidenceKey: 'verification-2' }],
    });
    expect(await services.exceptions.verify(context(), incident.id)).toBe(true);
    expect(evaluate).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantId }),
      expect.objectContaining({ id: incident.id, subject: incident.subject }),
    );
    const resolved = (await services.exceptions.list(context()))[0]!;
    expect(resolved.state).toBe('resolved');
    expect(resolved.resolution?.kind).toBe('verification');
    if (resolved.resolution?.kind === 'verification')
      expect(resolved.resolution.evaluatorVersion).toBe(
        'fixture-postcondition-v1',
      );
    expect(resolved.resolution?.auditId).toBeDefined();
    expect(
      (await services.exceptions.ingest(context(), request('event-2'))).incident
        ?.previousExceptionId,
    ).toBe(incident.id);
  });
  it('keeps connection scopes independent and rejects evidence outside the declared scope', async () => {
    const first = await services.exceptions.ingest(context(), request());
    const other = request('other-connection');
    const connection = randomUUID();
    if (other.input.exceptionClass === 'sync_failure')
      other.input.facts.connectionId = connection;
    await expect(services.exceptions.ingest(context(), other)).rejects.toThrow(
      'connection',
    );
    other.evidence[0]!.connectionId = connection;
    const second = await services.exceptions.ingest(context(), other);
    expect(second.incident?.id).not.toBe(first.incident?.id);
  });
  it('persists pending diagnoses, deduplicates revisions and protects tenant reads', async () => {
    const incident = (await services.exceptions.ingest(context(), request()))
      .incident!;
    expect(await services.diagnoses.get(context(), incident.id)).toMatchObject({
      status: 'pending',
      revision: 1,
    });
    const ready = await services.diagnoses.run(context(), incident.id);
    expect(ready).toMatchObject({
      status: 'ready',
      revision: 1,
      superseded: false,
    });
    expect(ready!.facts.length).toBeGreaterThan(0);
    await services.exceptions.ingest(context(), request());
    expect(await services.diagnoses.run(context(), incident.id)).toEqual(ready);
    expect(
      await services.diagnoses.history(context(), incident.id),
    ).toHaveLength(1);
    expect(
      await services.diagnoses.get(context(otherTenant), incident.id),
    ).toBeNull();
    expect(
      await services.diagnoses.history(context(otherTenant), incident.id),
    ).toEqual([]);
    const next = request('event-2');
    await services.exceptions.ingest(context(), next);
    expect(await services.diagnoses.get(context(), incident.id)).toMatchObject({
      status: 'pending',
      revision: 2,
    });
    expect(
      (await services.diagnoses.history(context(), incident.id))[0],
    ).toMatchObject({ superseded: true });
    await services.exceptions.ingest(context(), request());
    expect(await services.diagnoses.get(context(), incident.id)).toMatchObject({
      revision: 2,
    });
    next.configuration.version = 'configuration-2';
    await services.exceptions.ingest(context(), next);
    expect(await services.diagnoses.get(context(), incident.id)).toMatchObject({
      status: 'pending',
      revision: 3,
      provenance: { configVersion: 'configuration-2' },
    });
    expect((await services.exceptions.list(context()))[0]?.state).toBe(
      'detected',
    );
    await runtime.query('BEGIN');
    try {
      await runtime.query("SELECT set_config('app.tenant_id',$1,true)", [
        otherTenant,
      ]);
      expect(
        (await runtime.query('SELECT * FROM exception_diagnoses')).rowCount,
      ).toBe(0);
    } finally {
      await runtime.query('ROLLBACK');
    }
  });
  it('does not publish an older asynchronous model result over newer evidence', async () => {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = {
      async generate<T>() {
        started();
        await gate;

        return {
          output: { hypotheses: [] } as T,
          toolCalls: [],
          metadata: {
            adapter: 'bedrock-eu' as const,
            model: 'fixture',
            latencyMs: 1,
            inputTokens: 1,
            outputTokens: 1,
            costUsd: null,
          },
        };
      },
    };
    const withModel = createDetectionServices(
      runtimeUrl,
      () => now,
      undefined,
      { model: { gateway, profile: 'diagnosis' } },
    );
    try {
      const incident = (await services.exceptions.ingest(context(), request()))
        .incident!;
      const pending = withModel.diagnoses.run(context(), incident.id);
      await waiting;
      await services.exceptions.ingest(context(), request('new-evidence'));
      release();
      expect(await pending).toMatchObject({ status: 'pending', revision: 2 });
      expect(
        (await services.diagnoses.history(context(), incident.id))[0],
      ).toMatchObject({ superseded: true, status: 'pending' });
    } finally {
      release();
      await withModel.close();
    }
  });
  it.each([
    'invented_evidence',
    'unsafe_action',
    'invalid_schema',
    'failure',
    'valid',
  ] as const)(
    'preserves deterministic facts with model outcome %s',
    async (mode) => {
      const generate = vi.fn(
        async <T>(
          _trace: unknown,
          modelRequest: {
            output?: { parse(value: unknown): T };
            dataPolicy: unknown;
            tools?: unknown;
          },
        ) => {
          expect(modelRequest.dataPolicy).toEqual({
            classification: 'sensitive',
            region: 'EU',
            zeroDataRetention: true,
          });
          expect(modelRequest.tools).toBeUndefined();
          if (mode === 'failure') throw new Error('private provider error');
          const output =
            mode === 'invalid_schema'
              ? { confidence: 0.99 }
              : {
                  hypotheses: [
                    {
                      code: 'connection_access_or_provider',
                      evidenceRefs: [
                        mode === 'invented_evidence'
                          ? 'other-tenant-evidence'
                          : 'event-1',
                      ],
                    },
                  ],
                };

          return {
            output: output as T,
            toolCalls:
              mode === 'unsafe_action'
                ? [{ id: 'write', name: 'inventory.write', arguments: {} }]
                : [],
            metadata: {
              adapter: 'bedrock-eu' as const,
              model: 'fixture',
              latencyMs: 1,
              inputTokens: 1,
              outputTokens: 1,
              costUsd: null,
            },
          };
        },
      );
      const withModel = createDetectionServices(
        runtimeUrl,
        () => now,
        undefined,
        {
          model: {
            gateway: { generate: generate as ModelGateway['generate'] },
            profile: 'diagnosis',
          },
        },
      );
      try {
        const incident = (
          await services.exceptions.ingest(context(), request())
        ).incident!;
        await withModel.diagnoses.get(context(), incident.id);
        expect(generate).not.toHaveBeenCalled();
        const value = await withModel.diagnoses.run(context(), incident.id);
        expect(value).toMatchObject({
          status: 'ready',
          provenance: {
            model: {
              status:
                mode === 'valid'
                  ? 'used'
                  : mode === 'failure'
                    ? 'unavailable'
                    : 'rejected',
            },
          },
        });
        expect(value!.facts[0]?.code).toBe('scan_result');
        expect(JSON.stringify(value)).not.toContain('private provider error');
        await withModel.diagnoses.run(context(), incident.id);
        expect(generate).toHaveBeenCalledTimes(1);
      } finally {
        await withModel.close();
      }
    },
  );
  it('publishes insufficient evidence on a later incomplete scan and preserves facts if rereading fails', async () => {
    const incident = (await services.exceptions.ingest(context(), request()))
      .incident!;
    await services.diagnoses.run(context(), incident.id);
    const next = request('incomplete');
    if (next.input.exceptionClass === 'sync_failure') {
      next.input.facts.status = 'success';
      next.input.facts.errorCode = null;
    }
    await services.exceptions.ingest(context(), next);
    const read = vi.fn(async () => {
      throw new Error('provider secret');
    });
    const withRead = createDetectionServices(runtimeUrl, () => now, undefined, {
      rereader: { read },
    });
    try {
      expect(
        await withRead.diagnoses.run(context(), incident.id),
      ).toMatchObject({
        status: 'failed',
        reason: 'authoritative_read_failed',
        facts: [{ code: 'scan_result' }],
        provenance: { reread: { status: 'failed' } },
      });
      expect(read).toHaveBeenCalledTimes(1);
      const recovered = await services.diagnoses.run(context(), incident.id);
      expect(recovered).toMatchObject({
        status: 'insufficient_evidence',
        reason: 'incomplete_evidence',
      });
      expect((await services.exceptions.list(context()))[0]?.state).not.toBe(
        'resolved',
      );
    } finally {
      await withRead.close();
    }
  });
  it('retains normalized mapping provenance and expires inventory recommendations without model calls', async () => {
    const data = await detectionFixtures(context(), now);
    const left = data.jtlInventory.items[0]!,
      right = data.shopifyInventory.items[0]!;
    left.data.available = '4';
    right.data.available = '12';
    const result = await services.pipeline.inventory(context(), {
      left,
      right,
      mapping: {
        tenantId,
        version: 'mapping-v1',
        publishedAt: corpus.now,
        skuId: randomUUID(),
        locationId: randomUUID(),
        left: {
          source: left.source,
          sku: left.data.sku,
          location: left.data.location,
        },
        right: {
          source: right.source,
          sku: right.data.sku,
          location: right.data.location,
        },
        authority: 'left',
        sellingSource: 'right',
      },
      complete: true,
      projectionCurrent: true,
      configuration: defaultConfiguration,
    });
    const id = result.incident!.id;
    expect(await services.diagnoses.run(context(), id)).toMatchObject({
      status: 'ready',
      impact: { exposedQuantity: '8.000000', cost: null },
      provenance: { mappingVersions: ['mapping-v1'] },
    });
    expect(
      (await services.diagnoses.get(context(), id))!.provenance.evidence,
    ).toHaveLength(3);
    expect(await services.cases.get(context(), id)).toMatchObject({
      freshness: 'fresh',
      attention: { required: true, reason: 'manual_intervention' },
      diagnosis: { impact: { exposedQuantity: '8.000000' } },
      inventorySources: {
        left: left.source.provider,
        right: right.source.provider,
      },
    });
    now = new Date(now.getTime() + 301_000);
    expect(await services.cases.get(context(), id)).toMatchObject({
      freshness: 'stale',
      attention: { required: false },
      diagnosis: {
        nextSteps: [],
        superseded: true,
        status: 'insufficient_evidence',
      },
    });
    expect(await services.diagnoses.get(context(), id)).toMatchObject({
      status: 'insufficient_evidence',
      superseded: true,
      reason: 'stale_evidence',
      nextSteps: [],
    });
    expect((await services.exceptions.list(context()))[0]!.state).toBe(
      'detected',
    );
  });
  it('respects persisted retry-after when a read is rate limited', async () => {
    const incident = (await services.exceptions.ingest(context(), request()))
      .incident!;
    const next = request('incomplete');
    if (next.input.exceptionClass === 'sync_failure') {
      next.input.facts.status = 'success';
      next.input.facts.errorCode = null;
    }
    await services.exceptions.ingest(context(), next);
    const read = vi.fn(async () => ({
      status: 'rate_limited' as const,
      retryAfter: new Date(now.getTime() + 60_000).toISOString(),
    }));
    const withRead = createDetectionServices(runtimeUrl, () => now, undefined, {
      rereader: { read },
    });
    try {
      expect(
        await withRead.diagnoses.run(context(), incident.id),
      ).toMatchObject({
        status: 'failed',
        reason: 'authoritative_read_rate_limited',
      });
      await withRead.diagnoses.run(context(), incident.id);
      expect(read).toHaveBeenCalledTimes(1);
      now = new Date(now.getTime() + 60_000);
      await withRead.diagnoses.run(context(), incident.id);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      await withRead.close();
    }
  });
  it('does not create a diagnosis for a negative or deferred detection without an incident', async () => {
    const next = request();
    if (next.input.exceptionClass === 'sync_failure') {
      next.input.facts.active = false;
    }
    expect(
      (await services.exceptions.ingest(context(), next)).incident,
    ).toBeNull();
    expect(
      (await owner.query('SELECT * FROM exception_diagnoses')).rowCount,
    ).toBe(0);
  });
  it('reevaluates newest evidence on configuration changes and never restores old recommendations', async () => {
    const incident = (await services.exceptions.ingest(context(), request()))
      .incident!;
    await services.diagnoses.run(context(), incident.id);
    now = new Date(now.getTime() + 1000);
    const next = request('newest');
    next.evidence[0]!.observedAt = now.toISOString();
    await services.exceptions.ingest(context(), next);
    await services.diagnoses.run(context(), incident.id);
    const configUpdate = request();
    configUpdate.configuration.version = 'config-2';
    await services.exceptions.ingest(context(), configUpdate);
    expect(await services.diagnoses.get(context(), incident.id)).toMatchObject({
      status: 'pending',
      revision: 3,
      provenance: { configVersion: 'config-2', evidence: [{ id: 'newest' }] },
    });
    await services.diagnoses.run(context(), incident.id);
    await services.exceptions.ingest(context(), request());
    expect(await services.diagnoses.get(context(), incident.id)).toMatchObject({
      status: 'pending',
      revision: 4,
      provenance: {
        configVersion: defaultConfiguration.version,
        evidence: [{ id: 'newest' }],
      },
    });
    expect(
      (await services.diagnoses.history(context(), incident.id))
        .slice(0, 3)
        .every((d) => d.superseded),
    ).toBe(true);
  });
});
