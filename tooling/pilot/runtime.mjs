import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  buildApp,
  createApplicationServices,
  createCommerceServices,
  createExceptionWorkflowRuntime,
  createReadinessCheck,
  createResourceScope,
} from '@luma/application-runtime';
import { ConnectorError } from '@luma/connections';
import {
  createCapabilityRuntime,
  createJtlConnector,
} from '@luma/connections/adapters';
import {
  createInstallationVerifier,
  createInstalledConnections,
  createInstalledRuntime,
  createInstalledShippingMethodEffects,
  createReadChecks,
  createShippingMethodEffects,
  createSimulationTransport,
} from '@luma/connections/composition';
import { parseAction } from '@luma/execution/composition';
import { IdentityError } from '@luma/identity';
import { createIdentity } from '@luma/identity/composition';
import { registerIdentityHttp } from '@luma/identity/http';
import { createTenantDatabase } from '@luma/platform/composition';
import {
  createProposalRefresher,
  shippingMethodPlaybook,
} from '@luma/resolution';
import { createPlaybookStore } from '@luma/resolution/composition';
import { createDeskWorkflowReader } from '@luma/workflow-temporal';
import { Pool } from 'pg';

import { createInventoryScenario } from '../simulator/inventory.mjs';
import { observeProviders } from '../simulator/observations.mjs';
import { detectionRequest, readJson } from './fixtures.mjs';
import { mutateProviderState } from './provider-state.mjs';
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
  {
    pause = () => delay(20_000),
    proposalFreshnessMs = 300_000,
    observability,
    role = 'api',
  } = {},
) {
  if (process.env.NODE_ENV === 'production' || !manifest.synthetic)
    throw new Error('The synthetic pilot is for local development only');
  const settings = identitySettings(env);
  const resources = createResourceScope();
  try {
    const identity = createIdentity(settings);
    resources.add(identity.close);
    const pool = new Pool({ connectionString: env.WORKFLOW_DATABASE_URL });
    resources.add(() => pool.end());
    const db = createTenantDatabase(pool);
    const path = join(directory, `provider-${manifest.runId}.json`);
    const mutate = (operation) => mutateProviderState(pool, path, operation);
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
    const commerce = simulation ? createCommerceServices(db) : undefined;
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
    const inventory = simulation
      ? await createInventoryScenario({
          commerce,
          capabilities,
          operator,
          manifest,
        })
      : null;
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
            diagnosis.provenance.evidence.some(
              (evidence) => evidence.id === ref,
            ),
          )
        );
      },
    };
    const effects = simulation
      ? createInstalledShippingMethodEffects(installedOptions, effectBinding)
      : createShippingMethodEffects(capabilities, effectBinding);
    const verifier = {
      version: simulation
        ? 'simulator-verification-v1'
        : 'synthetic-shipping-correction-v1',
      async evaluate(actor, incident) {
        if (inventory && incident.exceptionClass === 'inventory_mismatch')
          return inventory.monitor.verifier.evaluate(actor, incident);
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
    const reader = temporal
      ? createDeskWorkflowReader(temporal, identity.service)
      : null;
    if (reader) resources.add(reader.close);
    const application = createApplicationServices({
      database: db,
      identity: identity.service,
      execution: { kind: 'enabled', effects },
      verifier,
      desk: {
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
      },
    });
    const {
      detection,
      safety,
      playbooks,
      library,
      desk: deskService,
    } = application;
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
    const app =
      role === 'api'
        ? buildApp(
            { logger: false },
            {
              observability,
              identity: identity.service,
              trustedOrigins: settings.trustedOrigins,
              ...application.http,
              desk,
              playbooks: library,
              connections,

              checkReadiness: createReadinessCheck(
                identity.checkReadiness,
                pool,
              ),
            },
          )
        : undefined;
    if (app) {
      resources.add(() => app.close());
      registerIdentityHttp(app, identity);
      if (inventory) {
        const base = '/v1/organizations/:organizationId/simulator/inventory';
        app.get(base, (request) =>
          inventory.status(request.tenantContext, detection.exceptions),
        );
        app.post(`${base}/check`, (request) =>
          inventory.check(request.tenantContext, detection),
        );
      }
    }
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
                      (item) =>
                        Date.parse(item.observedAt) + proposalFreshnessMs,
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
            async activationId(actor, action) {
              const existing = await createPlaybookStore(db).run(
                actor,
                action.id,
              );
              if (existing) return existing.activationId;
              const current = await library.detail(
                actor,
                shippingMethodPlaybook.definition.id,
              );

              return (
                current.activations.find(
                  (grant) =>
                    grant.active &&
                    grant.policyVersion === current.policyVersion &&
                    grant.grants.principalIds.includes(actor.actor.id) &&
                    grant.grants.connectionIds.includes(action.connectionId) &&
                    grant.grants.targetIds.includes(action.target.id),
                )?.id ?? null
              );
            },
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

      return createProposalRefresher({
        desk: deskService,
        capabilities,
        exceptions: detection.exceptions,
        diagnoses: detection.diagnoses,
        connectionId: manifest.connections.jtl,
        order: { externalId: '10', scopeKey: '' },
        expectedShippingMethod: '7',
        detectionRequest: (observationId) =>
          detectionRequest(manifest, 'workflow_failure', observationId),
        propose: (actor, exceptionId, revision) =>
          runtime.activities.propose(
            {
              tenantId: actor.tenantId,
              userId: actor.actor.id,
              requestId: actor.requestId,
              source: { kind: 'incident', id: exceptionId },
            },
            exceptionId,
            revision,
          ),
        evaluate: (actor, action) =>
          safety.policies.evaluate(actor, action, parseAction(action).hash, {
            available: true,
            minimumRisk: 'high',
          }),
        now: Date.now,
      })(await context(), exceptionId);
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
      observe: async () => {
        if (simulation) {
          await observeProviders({
            context,
            installations,
            capabilities,
            recordRead,
            manifest,
            onError: (error) =>
              app ? app.log.error(error) : console.error(error),
          });
          await inventory.check(await operator(), detection);
        }
      },
      close: resources.close,
    };
  } catch (error) {
    try {
      await resources.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Pilot startup failed', {
        cause: cleanup,
      });
    }
    throw error;
  }
}
