import { createHash } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Pool } from 'pg';

import {
  buildApp,
  createAdmissionEligibility,
  createCommerceServices,
  createDeskServices,
  createDetectionServices,
  createExceptionWorkflowRuntime,
  createResolutionPlaybooks,
  createSafetyServices,
} from '../../apps/api/dist/app.js';
import { createCapabilityRuntime } from '../../apps/api/dist/modules/connectors/application/capabilities.js';
import {
  createConnectionCoverage,
  createInstallationVerifier,
  createInstalledConnections,
  createInstalledRuntime,
  createInstalledShippingMethodEffects,
  createReadChecks,
  createShippingMethodEffects,
  createSimulationTransport,
} from '../../apps/api/dist/modules/connectors/composition.js';
import { ConnectorError } from '../../apps/api/dist/modules/connectors/index.js';
import { createJtlConnector } from '../../apps/api/dist/modules/connectors/infrastructure/jtl/adapter.js';
import { parseAction } from '../../apps/api/dist/modules/execution/composition.js';
import { createIdentity } from '../../apps/api/dist/modules/identity/composition.js';
import { IdentityError } from '../../apps/api/dist/modules/identity/index.js';
import { createTenantDatabase } from '../../apps/api/dist/modules/platform/composition.js';
import {
  createDeskWorkflowReader,
  createOperationsOverview,
} from '../../apps/api/dist/modules/workflows/composition.js';
import { shippingMethodPlaybook } from '../../apps/api/dist/modules/workflows/index.js';
import { observeProviders } from '../simulator/observations.mjs';
import { detectionRequest, readJson } from './fixtures.mjs';
import { identitySettings } from './seed.mjs';

/**
 * Creates the synthetic pilot's services and provider fixtures; rejects production use and
 * exposes close for cleanup.
 */
export async function createPilot(
  env,
  directory,
  manifest,
  temporal,
  { pause = () => delay(20_000), proposalFreshnessMs = 300_000 } = {},
) {
  if (process.env.NODE_ENV === 'production' || !manifest.synthetic)
    throw new Error('The synthetic pilot is for local development only');
  const settings = identitySettings(env);
  const identity = createIdentity(settings);
  const pool = new Pool({ connectionString: env.WORKFLOW_DATABASE_URL });
  const db = createTenantDatabase(pool);
  const path = join(directory, `provider-${manifest.runId}.json`);
  let writes = Promise.resolve();
  const mutate = (operation) => {
    const work = writes.then(async () => {
      const state = await readJson(path);
      const result = operation(state);
      await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
        flush: true,
      });
      await rename(`${path}.tmp`, path);

      return result;
    });
    writes = work.catch(() => {
      // Let later mutations proceed; the caller still receives the rejected work.
    });

    return work;
  };
  const context = () =>
    identity.service.resolveWorkflowContext(
      manifest.requesterId,
      manifest.organizationId,
      'synthetic-pilot',
    );
  const operator = () =>
    identity.service.resolveWorkflowContext(
      manifest.operatorId,
      manifest.organizationId,
      'synthetic-pilot-operator',
    );
  const simulation = manifest.simulator
    ? createSimulationTransport(manifest.simulator)
    : undefined;
  const installations = createInstalledConnections(db, {
    refreshContext: identity.service.refreshContext,
    activeKeyId: env.CONNECTIONS_ACTIVE_KEY_ID,
    keys: new Map(
      Object.entries(JSON.parse(env.CONNECTIONS_KEYS)).map(([id, key]) => [
        id,
        Buffer.from(key, 'base64'),
      ]),
    ),
    verify: simulation
      ? createInstallationVerifier({ simulation, jtlEndpoints: [] })
      : async () => {
          throw new Error(
            'Synthetic pilot does not verify connected-system health',
          );
        },
  });
  const connections = {
    ...installations,
    async check(actor, connectionId, version) {
      if (
        actor.tenantId !== manifest.organizationId ||
        !Object.values(manifest.connections).includes(connectionId)
      )
        throw new IdentityError(404, 'NOT_FOUND', 'Connection not found');

      return installations.check(actor, connectionId, version);
    },
  };

  async function connectionAvailable(actor, connectionId) {
    if (
      actor.tenantId !== manifest.organizationId ||
      connectionId !== manifest.connections.jtl
    )
      return false;
    const connection = (await installations.list(actor)).find(
      (item) => item.id === connectionId,
    );

    // Pending fixture configuration is usable without claiming live provider health.
    return (
      !!connection &&
      (simulation
        ? connection.status === 'active'
        : !['disconnected', 'revoked'].includes(connection.status))
    );
  }

  const id = manifest.incidents.workflow_failure;
  const connector = createJtlConnector({
    tenantId: manifest.organizationId,
    connectionId: manifest.connections.jtl,
    connection: {
      kind: 'onprem',
      baseUrl: 'http://127.0.0.1:5883/api/eazybusiness/',
      appId: 'LumaSyntheticPilot',
      appVersion: '1',
      challengeCode: 'synthetic',
      apiKey: async () => {
        if (
          !(await connectionAvailable(
            await context(),
            manifest.connections.jtl,
          ))
        )
          throw new ConnectorError({
            code: 'unavailable',
            effect: 'none',
            retry: 'never',
          });

        return 'synthetic';
      },
    },
    shippingMethodActions: true,
    recordObservations: ({ observations }) =>
      mutate((state) => {
        state.observations.push(...observations);
      }),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/sales-orders/10'))
        throw new Error('Unknown synthetic provider target');
      if (init?.method !== 'PATCH') {
        const order = (await readJson(path)).order;

        return Response.json({
          shippingDetails: { shippingDate: null },
          ...order,
        });
      }
      if (manifest.scenario === 'failed')
        return new Response(null, { status: 409 });
      if (manifest.scenario === 'executing') await pause('executing');
      const key = new Headers(init.headers).get('Idempotency-Key');
      const body = JSON.parse(String(init.body));
      await mutate((state) => {
        if (
          !key ||
          body.disableAutomaticWorkflows !== true ||
          String(body.shippingMethodId) !== '8'
        )
          throw new Error('Unexpected synthetic write');
        state.patchRequests = (state.patchRequests ?? 0) + 1;
        if (!state.effects.some((effect) => effect.key === key)) {
          state.order.shippingMethodId = '8';
          state.effects.push({ key, shippingMethodId: '8' });
        }
      });
      if (manifest.scenario === 'recovery') {
        console.log(
          'PILOT_EFFECT_COMMITTED: kill the worker now; restart to reconcile without another write.',
        );
        await delay(40_000);
        throw new Error('Simulated lost provider response');
      }

      return Response.json({ salesOrderId: '10' });
    },
  });
  const commerce = simulation
    ? createCommerceServices(env.WORKFLOW_DATABASE_URL)
    : undefined;
  const recordRead = createReadChecks(db);
  const installedOptions = {
    installations,
    simulation,
    jtlEndpoints: [],
    approveJtlEndpoint: async () => {
      throw new Error('Synthetic connection has no production destination');
    },
    record: async (entry) => {
      await mutate((state) => {
        (state.capabilityEvents ??= []).push(entry);
      });
    },
    recordObservations: async ({ capability, observations }) => {
      if (
        commerce &&
        ['orders.read', 'inventory.read', 'fulfillment.read'].includes(
          capability,
        )
      ) {
        const actor = await context();
        for (const observation of observations)
          await commerce.ingestion.ingest(
            actor,
            `simulator:${observation.id}`,
            { capability, observation },
          );
      }
      await mutate((state) => {
        state.observations.push(...observations);
      });
    },
  };
  const capabilities = simulation
    ? createInstalledRuntime(installedOptions)
    : createCapabilityRuntime({
        resolve: async (actor, connectionId) =>
          (await connectionAvailable(actor, connectionId)) ? connector : null,
        record: async () => {
          // The synthetic pilot does not export capability telemetry.
        },
      });
  const supported = (action) =>
    action.tenantId === manifest.organizationId &&
    action.connectionId === manifest.connections.jtl &&
    action.target.id === manifest.subjects.workflow_failure;
  const effectBinding = {
    map: async (_actor, action) =>
      supported(action)
        ? {
            order: { externalId: '10', scopeKey: '' },
            expectedShippingMethod: { externalId: '7', scopeKey: '' },
            shippingMethod: { externalId: '8', scopeKey: '' },
          }
        : null,
    checkPreconditions: async (actor, action) => {
      const diagnosis = await detection.diagnoses.get(actor, id);

      return (
        supported(action) &&
        (await connectionAvailable(actor, action.connectionId)) &&
        diagnosis?.status === 'ready' &&
        !diagnosis.superseded &&
        action.preconditions.evidenceRefs.every((ref) =>
          diagnosis.provenance.evidence.some((evidence) => evidence.id === ref),
        )
      );
    },
  };
  const effects = simulation
    ? createInstalledShippingMethodEffects(installedOptions, effectBinding)
    : createShippingMethodEffects(capabilities, effectBinding);
  const verifier = {
    version: 'synthetic-shipping-correction-v1',
    async evaluate(actor, incident) {
      if (manifest.scenario === 'verifying') await pause('verifying');
      // A fresh adapter read verifies this workflow's shipping correction, not shipment completion.
      const result = await capabilities.read(actor, {
        connectionId: manifest.connections.jtl,
        capability: 'orders.shipping-method.read',
        version: '0',
        input: { order: { externalId: '10', scopeKey: '' }, limit: 1 },
      });
      const observation = result.ok ? result.value.items[0] : null;
      const passed =
        incident.id === id &&
        observation?.data?.shippingMethod?.externalId === '8' &&
        !observation.data.isCancelled;
      const key = `pilot-verification:${manifest.runId}:${Date.now()}`;

      return {
        reason: 'Synthetic JTL order shipping method independently reread',
        outcome: passed ? 'passed' : 'inconclusive',
        complete: !!observation,
        authoritative: true,
        evidence: [
          {
            key,
            tenantId: actor.tenantId,
            connectionId: null,
            observedAt: new Date().toISOString(),
            sourceUpdatedAt: null,
            adapterVersion: 'synthetic-pilot-v1',
            schemaVersion: 1,
            source: {
              provider: 'jtl',
              resource: 'order',
              externalId: '10',
              scopeKey: '',
            },
            facts: {
              synthetic: true,
              shippingMethodId:
                observation?.data?.shippingMethod?.externalId ?? null,
            },
          },
        ],
        bindings: [
          {
            evidenceKey: key,
            exceptionClass: 'workflow_failure',
            subject: incident.subject,
            postcondition: 'workflow_business_postcondition_verified',
          },
        ],
      };
    },
  };
  const detection = createDetectionServices(
    env.WORKFLOW_DATABASE_URL,
    () => new Date(),
    verifier,
  );
  const safety = createSafetyServices(
    env.WORKFLOW_DATABASE_URL,
    identity.service,
    effects,
    { eligible: createAdmissionEligibility(detection.diagnoses) },
  );
  const playbooks = createResolutionPlaybooks(db, identity.service, safety);
  await playbooks.publish(await context(), shippingMethodPlaybook);
  const activation = await playbooks.activate(await context(), {
    id: manifest.proposalId,
    definitionId: shippingMethodPlaybook.definition.id,
    version: shippingMethodPlaybook.version,
    grants: {
      principalIds: [manifest.requesterId],
      connectionIds: [manifest.connections.jtl],
      targetIds: [manifest.subjects.workflow_failure],
    },
    policyVersion: 'v0.1',
  });
  const reader = temporal
    ? createDeskWorkflowReader(temporal, identity.service)
    : null;
  const deskService = createDeskServices(db, identity.service, effects, {
    capability: supported,
    notifyDecision: async (actor, exceptionId) => {
      if (!runtime) return;
      const client = await runtime.createClient();
      try {
        await client.notifyApproval(actor, {
          kind: 'incident',
          id: exceptionId,
        });
      } finally {
        await client.close();
      }
    },
    refreshProposal: async (_actor, exceptionId) => {
      await refreshProposal(exceptionId);
      if (runtime) {
        const client = await runtime.createClient();
        try {
          await client.start(
            await context(),
            { kind: 'incident', id: exceptionId },
            true,
          );
        } finally {
          await client.close();
        }
      }
    },
    ...(reader ? { workflow: reader.get } : {}),
  });
  const desk = {
    ...deskService,
    async review(actor, exceptionId) {
      const review = await deskService.review(actor, exceptionId);
      if (
        review.proposal &&
        !(await connectionAvailable(actor, review.proposal.connectionId))
      ) {
        review.proposal.available = false;
        review.permittedDecisions = review.permittedDecisions.filter(
          (kind) => kind !== 'approve',
        );
      }

      return review;
    },
  };
  const app = buildApp(
    { logger: false },
    {
      identity: identity.service,
      trustedOrigins: settings.trustedOrigins,
      cases: detection.cases,
      desk,
      connections,
      operations: createOperationsOverview(
        detection.cases,
        createConnectionCoverage(db),
      ),
      checkReadiness: identity.checkReadiness,
    },
  );
  identity.register(app);
  const runtime = temporal
    ? createExceptionWorkflowRuntime(
        temporal,
        identity.service,
        detection,
        safety,
        {
          refreshProposal: async (actor, exceptionId) => {
            try {
              await deskService.refresh(actor, exceptionId);
            } catch (error) {
              if (error instanceof IdentityError && error.statusCode === 409)
                return null;
              throw error;
            }
            const review = await deskService.review(actor, exceptionId);

            return review.proposal
              ? ((await desk.proposal(actor, review.proposal.id))?.action ??
                  null)
              : null;
          },
          proposals: {
            async prepare(actor, diagnosis) {
              if (
                actor.tenantId !== manifest.organizationId ||
                diagnosis.exceptionId !== id
              )
                return null;
              const review = await desk.review(actor, id);
              if (review.proposal?.diagnosisRevision === diagnosis.revision)
                return (
                  (await desk.proposal(actor, review.proposal.id))?.action ??
                  null
                );
              const hex = createHash('sha256')
                .update(`${manifest.proposalId}:${diagnosis.revision}`)
                .digest('hex');
              const proposalId = review.proposal
                ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
                : manifest.proposalId;
              const expiresAt = new Date(
                Math.min(
                  ...diagnosis.provenance.evidence.map(
                    (item) => Date.parse(item.observedAt) + proposalFreshnessMs,
                  ),
                ),
              ).toISOString();

              return {
                schemaVersion: 1,
                id: proposalId,
                tenantId: actor.tenantId,
                connectionId: manifest.connections.jtl,
                capability: 'orders.shipping-method.write',
                capabilityVersion: '0',
                target: {
                  kind: 'order',
                  id: manifest.subjects.workflow_failure,
                },
                parameters: {},
                preconditions: {
                  evidenceRefs: diagnosis.provenance.evidence.map(
                    (item) => item.id,
                  ),
                  validUntil: expiresAt,
                },
                expectedPostcondition: { shippingMethodId: '8' },
                risk: 'high',
                proposedBy: { kind: 'user', id: actor.actor.id },
                expiresAt,
              };
            },
            get: desk.proposal,
          },
        },
        desk,
        undefined,
        {
          service: playbooks,
          activationId: activation.id,
          async snapshot(_actor, diagnosis) {
            return {
              inputs: { shippingMethodId: '8' },
              evidence: {
                kind: 'workflow_failure',
                facts: {
                  diagnosisReady: diagnosis.status === 'ready',
                  methodMapped: true,
                },
                observations: diagnosis.provenance.evidence.map((item) => ({
                  id: item.id,
                  observedAt: item.observedAt,
                  source: `pilot:${item.adapterVersion}`,
                })),
              },
              provenance: {
                reference: `pilot:${manifest.runId}`,
                capturedAt: diagnosis.provenance.generatedAt,
              },
            };
          },
        },
      )
    : null;

  async function refreshProposal(exceptionId) {
    if (exceptionId !== id || !runtime)
      throw new IdentityError(
        409,
        'CONFLICT',
        'This case needs a new investigation.',
      );
    const actor = await context();
    const review = await deskService.review(actor, id);
    const progress = await deskService.progress(actor, id);
    if (
      (review.proposal?.approval && !review.refreshable) ||
      progress.execution ||
      ['resolved', 'escalated'].includes(progress.state)
    )
      return review.proposal
        ? ((await desk.proposal(actor, review.proposal.id))?.action ?? null)
        : null;
    const result = await capabilities.read(actor, {
      connectionId: manifest.connections.jtl,
      capability: 'orders.shipping-method.read',
      version: '0',
      input: { order: { externalId: '10', scopeKey: '' }, limit: 1 },
    });
    if (
      !result.ok ||
      result.value.completeness !== 'complete' ||
      result.value.items.length !== 1
    )
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'The order could not be checked. Try again shortly.',
      );
    const observation = result.value.items[0];
    if (observation.data.orderStatus !== 'open')
      throw new IdentityError(
        409,
        'CONFLICT',
        observation.data.orderStatus === 'shipped'
          ? 'The order has already shipped. Its shipping method can no longer be corrected.'
          : observation.data.orderStatus === 'cancelled'
            ? 'The order was cancelled. Review the case before choosing another action.'
            : 'The order’s current status could not be confirmed. Review the order before continuing.',
      );
    if (
      observation.data.isCancelled ||
      observation.data.shippingMethod.externalId !== '7'
    )
      throw new IdentityError(
        409,
        'CONFLICT',
        observation.data.isCancelled
          ? 'The order was cancelled. Review the case before choosing another action.'
          : 'The shipping method changed. Review the order before choosing another action.',
      );
    if (
      review.proposal &&
      Math.min(
        Date.parse(review.proposal.expiresAt),
        Date.parse(review.proposal.preconditions.validUntil),
      ) >
        Date.now() + 60_000
    )
      return (await desk.proposal(actor, review.proposal.id))?.action ?? null;
    const request = detectionRequest(
      manifest,
      'workflow_failure',
      observation.id,
    );
    request.evidence = request.evidence.map((evidence) => ({
      ...evidence,
      observedAt: observation.observedAt,
      facts: {
        ...evidence.facts,
        currentOrder: observation.data,
        observationId: observation.id,
        observationSource: observation.source,
      },
    }));
    await detection.exceptions.ingest(actor, request);
    const diagnosis = await detection.diagnoses.run(actor, id);
    if (!diagnosis || diagnosis.status !== 'ready' || diagnosis.superseded)
      throw new IdentityError(
        409,
        'CONFLICT',
        'The investigation changed. Review the current findings.',
      );
    const input = {
      tenantId: actor.tenantId,
      userId: actor.actor.id,
      requestId: actor.requestId,
      source: { kind: 'incident', id },
    };
    const proposal = await runtime.activities.propose(
      input,
      id,
      diagnosis.revision,
    );
    if (!proposal)
      throw new IdentityError(
        409,
        'CONFLICT',
        'No current proposal is available.',
      );
    // Policy evaluation records the independent approval requirement; this path never approves.
    const action = (await desk.proposal(actor, proposal.id))?.action;
    if (!action) return null;
    await safety.policies.evaluate(actor, action, parseAction(action).hash, {
      available: true,
      minimumRisk: 'high',
    });

    return action;
  }

  return {
    app,
    runtime,
    context,
    operator,
    detection,
    desk,
    safety,
    playbooks,
    provider: () => readJson(path),
    observe: () =>
      simulation
        ? observeProviders({
            context,
            installations,
            capabilities,
            recordRead,
            manifest,
            onError: (error) => app.log.error(error),
          })
        : Promise.resolve(),
    async close() {
      await app.close();
      await Promise.all([
        commerce?.close(),
        identity.close(),
        detection.close(),
        safety.close(),
        reader?.close(),
        pool.end(),
      ]);
    },
  };
}
