import type { ModelGateway } from './modules/platform/index.js';
import { parseInput } from './modules/exceptions/composition.js';
import { detectionFixtures } from './test-support/detection-fixtures.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
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
import { createDetectionServices } from './app.js';
import { makeTenantContext } from './modules/identity/composition.js';
import { defaultConfiguration } from './modules/exceptions/index.js';
import type {
  DetectionRequest,
  Evidence,
  VerificationEvaluator,
  VerificationResult,
  Incident,
} from './modules/exceptions/index.js';
import corpus from '../../../docs/fixtures/exceptions-v0.json' with { type: 'json' };

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
  function context(id = tenantId) {
    return makeTenantContext(
      { userId: 'operator', sessionId: 'session' },
      {
        id,
        name: 'Fixture',
        slug: 'fixture',
        dataRegion: 'EU',
        status: 'active',
      },
      {
        id: 'membership',
        organizationId: id,
        userId: 'operator',
        role: 'owner',
      },
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
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(`GRANT luma_exceptions TO "${name}"`);
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
    next.configuration.version = 'v0.2';
    next.configuration.thresholds.freshnessSeconds = 120;
    const result = await services.exceptions.ingest(context(), next);
    expect(result.incident?.id).toBe(initial.incident?.id);
    expect(result.incident?.state).toBe('failed');
    expect(result.incident?.configVersion).toBe('v0.2');
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
    now = new Date(now.getTime() + 301_000);
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
      provenance: { configVersion: 'v0.1', evidence: [{ id: 'newest' }] },
    });
    expect(
      (await services.diagnoses.history(context(), incident.id))
        .slice(0, 3)
        .every((d) => d.superseded),
    ).toBe(true);
  });
});
