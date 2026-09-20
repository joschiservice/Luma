import { createJtlConnector } from '../../apps/api/dist/modules/connectors/infrastructure/jtl/adapter.js';
import { createCapabilityRuntime } from '../../apps/api/dist/modules/connectors/application/capabilities.js';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import {
  buildApp,
  createDeskServices,
  createDetectionServices,
  createSafetyServices,
  createAdmissionEligibility,
  createExceptionWorkflowRuntime,
} from '../../apps/api/dist/app.js';
import { createIdentity } from '../../apps/api/dist/modules/identity/composition.js';
import { createTenantDatabase } from '../../apps/api/dist/modules/platform/composition.js';
import {
  createShippingMethodEffects,
  createInstalledConnections,
  createConnectionCoverage,
} from '../../apps/api/dist/modules/connectors/composition.js';
import { IdentityError } from '../../apps/api/dist/modules/identity/index.js';
import { ConnectorError } from '../../apps/api/dist/modules/connectors/index.js';
import {
  createOperationsOverview,
  createDeskWorkflowReader,
} from '../../apps/api/dist/modules/workflows/composition.js';
import { identitySettings } from './seed.mjs';
import { readJson } from './fixtures.mjs';

export async function createPilot(env, directory, manifest, temporal) {
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
    writes = work.catch(() => {});
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
  const installations = createInstalledConnections(db, {
    refreshContext: identity.service.refreshContext,
    activeKeyId: env.CONNECTIONS_ACTIVE_KEY_ID,
    keys: new Map(
      Object.entries(JSON.parse(env.CONNECTIONS_KEYS)).map(([id, key]) => [
        id,
        Buffer.from(key, 'base64'),
      ]),
    ),
    verify: async () => {
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
      !!connection && !['disconnected', 'revoked'].includes(connection.status)
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
      if (init?.method !== 'PATCH')
        return Response.json((await readJson(path)).order);
      if (manifest.scenario === 'failed')
        return new Response(null, { status: 409 });
      if (manifest.scenario === 'executing') await delay(20_000);
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
  const capabilities = createCapabilityRuntime({
    resolve: async (actor, connectionId) =>
      (await connectionAvailable(actor, connectionId)) ? connector : null,
    record: async () => {},
  });
  const supported = (action) =>
    action.tenantId === manifest.organizationId &&
    action.id === manifest.proposalId &&
    action.connectionId === manifest.connections.jtl &&
    action.target.id === manifest.subjects.workflow_failure;
  const effects = createShippingMethodEffects(capabilities, {
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
  });
  const verifier = {
    version: 'synthetic-shipping-correction-v1',
    async evaluate(actor, incident) {
      if (manifest.scenario === 'verifying') await delay(20_000);
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
  await safety.provisioning.activate(await context(), {
    id: 'exception-resolution',
    version: '1',
    generation: { kind: 'manual', reference: 'synthetic-pilot/1' },
    steps: {
      execute: {
        capability: 'orders.shipping-method.write',
        capabilityVersion: '0',
        targetKind: 'order',
        minimumRisk: 'high',
      },
    },
  });
  const reader = temporal
    ? createDeskWorkflowReader(temporal, identity.service)
    : null;
  const deskService = createDeskServices(db, identity.service, effects, {
    capability: supported,
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
          proposals: {
            async prepare(actor, diagnosis) {
              if (
                actor.tenantId !== manifest.organizationId ||
                diagnosis.exceptionId !== id
              )
                return null;
              const existing = await desk.proposal(actor, manifest.proposalId);
              if (existing) return existing.action;
              const expiresAt =
                diagnosis.provenance.validUntil ??
                new Date(Date.parse(manifest.epoch) + 300_000).toISOString();
              return {
                schemaVersion: 1,
                id: manifest.proposalId,
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
      )
    : null;
  return {
    app,
    runtime,
    context,
    operator,
    detection,
    desk,
    safety,
    provider: () => readJson(path),
    async close() {
      await app.close();
      await Promise.all([
        identity.close(),
        detection.close(),
        safety.close(),
        reader?.close(),
        pool.end(),
      ]);
    },
  };
}
