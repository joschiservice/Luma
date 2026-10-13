import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createJtlConnector } from '@luma/app-jtl';
import {
  buildApp,
  createApplicationServices,
  createCommerceServices,
  createExceptionWorkflowRuntime,
  createMetricListener,
  createOrderLineReader,
  createReadinessCheck,
  createReplenishmentWorker,
  createResourceScope,
  createSalesReadSource,
  createSalesTenantRelease,
  createScheduledDetection,
  createShipmentDispatchOptionsReader,
  createShipmentDispatchReader,
  createStockRefreshService,
  createTenantFeatureRelease,
} from '@luma/application-runtime';
import {
  createAutomaticLinkStore,
  createCommerceSyncService,
  createPurchasingTermsRecorder,
} from '@luma/application-runtime/sync';
import { createAutoLinkRunner, createSyncRunner } from '@luma/commerce-sync';
import { createSyncStore } from '@luma/commerce-sync/composition';
import { ConnectorError } from '@luma/connections';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import {
  createReadChecks,
  createShippingMethodEffects,
  createSimulationTransport,
} from '@luma/connections/composition';
import { createCustomerProfiles } from '@luma/customers/composition';
import { defaultConfiguration } from '@luma/exceptions';
import { parseAction } from '@luma/execution/composition';
import { IdentityError } from '@luma/identity';
import { createIdentity } from '@luma/identity/composition';
import { registerIdentityHttp } from '@luma/identity/http';
import { createFailureLog } from '@luma/platform';
import { createTenantDatabase } from '@luma/platform/composition';
import {
  createProposalRefresher,
  shippingMethodPlaybook,
} from '@luma/resolution';
import { createPlaybookStore } from '@luma/resolution/composition';
import {
  createDeskWorkflowReader,
  createProcessClient,
} from '@luma/workflow-temporal';
import { Pool } from 'pg';

import {
  createInstallationVerifier,
  createInstalledConnections,
  createInstalledMessageRuntime,
  createInstalledPurchaseOrderRuntime,
  createInstalledReturnRuntime,
  createInstalledRuntime,
  createInstalledShippingMethodEffects,
} from '../apps/providers.mjs';
import { lumaCases } from '../simulator/cases.mjs';
import { createWorkflowDemo, demoDetection } from '../simulator/demo.mjs';
import { createInventoryScenario } from '../simulator/inventory.mjs';
import { createStockLinks } from '../simulator/links.mjs';
import { createQuantityChanges } from '../simulator/quantity-change.mjs';
import { simulatorShopifyEnv } from '../simulator/shopify-app.mjs';
import { syntheticFeatureRelease } from './feature-release.mjs';
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
    modelGateway,
    supplierExtraction,
    role = 'api',
    // Detection timing for scheduled detection: `configuration` and `holdOverdueSeconds`.
    // Simulator workspaces provisioned for the workflow demo default to faster windows.
    detection: detectionTiming = manifest.simulator?.demo?.detection === 'demo'
      ? demoDetection(defaultConfiguration)
      : {},
  } = {},
) {
  if (process.env.NODE_ENV === 'production' || !manifest.synthetic)
    throw new Error('The synthetic pilot is for local development only');
  const settings = identitySettings(env);
  const resources = createResourceScope();
  const failureLog = createFailureLog(observability);
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
    // Owners reread stale stock and order sources right before they act; created once
    // capabilities exist. Plans come from the Orders workspace composed below.
    let stockRefresh = null;
    let orderRefresh = null;
    let orderPlans = null;
    const refreshStock = async (actor, positionId) =>
      stockRefresh?.refresh(actor, positionId);
    const installations = createInstalledConnections(db, {
      refreshStock,
      sourceOrderLines: createOrderLineReader(db),
      shipmentDispatchOptions: createShipmentDispatchOptionsReader(db),
      shipmentDispatchEvidence: createShipmentDispatchReader(
        db,
        async (actor, orderId, maxAgeMs) => {
          await orderRefresh?.(actor, orderId, maxAgeMs);
        },
      ),
      refreshOrder: async (actor, orderId, maxAgeMs) => {
        await orderRefresh?.(actor, orderId, maxAgeMs);
      },
      internalOrdersEnabled: createSalesTenantRelease(observability),
      featureEnabled: syntheticFeatureRelease(
        env,
        createTenantFeatureRelease(observability),
      ),
      orderChangePlans: async (actor, orderId, request) => {
        if (!orderPlans) throw new Error('Order plans are not composed yet');

        return orderPlans.changePlan(actor, orderId, request);
      },
      ...(simulation
        ? {
            simulation,
            // Signed simulator webhooks reach the real Shopify change route.
            env: simulatorShopifyEnv(manifest.simulator.webhookSecret),
            customerAccess: { contact: true, address: true },
          }
        : {}),
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
    // The plain pilot's synthetic JTL order; simulator runs read their providers instead.
    const connector = simulation
      ? null
      : createJtlConnector({
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
    const installedOptions = {
      providers: installations.registry.providers(),
      featureEnabled: syntheticFeatureRelease(
        env,
        createTenantFeatureRelease(observability),
      ),
      internalSource: createSalesReadSource(db, observability),
      installations,
      simulation,
      jtlEndpoints: [],
      customerAccess: { contact: true, address: true },
      approveJtlEndpoint: async () => {
        throw new Error('Synthetic connection has no production destination');
      },
      record: async (entry) => {
        await mutate((state) => {
          (state.capabilityEvents ??= []).push(entry);
        });
      },
      // Simulated history is imported by the commerce sync runner, as for live connections.
      recordObservations: async () => undefined,
    };
    const syncStore = simulation ? createSyncStore(db) : undefined;
    const syncRunner = simulation
      ? createSyncRunner({
          automaticLinks: createAutoLinkRunner({
            store: createAutomaticLinkStore(db),
            resolveContext: identity.service.resolveWorkflowContext,
            log: failureLog,
          }),
          store: syncStore,
          reader: createInstalledRuntime({
            ...installedOptions,
            record: async () => undefined,
          }),
          ingestion: commerce.ingestion,
          recordPurchasingTerms: createPurchasingTermsRecorder(
            db,
            identity.service.refreshContext,
            (actor) =>
              syntheticFeatureRelease(
                env,
                createTenantFeatureRelease(observability),
              )(actor.tenantId, 'supplier-purchasing-terms'),
          ),
          customers: createCustomerProfiles(db),
          recordRead: createReadChecks(db),
          resolveContext: identity.service.resolveWorkflowContext,
          digest: (value) => createHash('sha256').update(value).digest('hex'),
          log: failureLog,
        })
      : undefined;
    const capabilities = simulation
      ? createInstalledRuntime(installedOptions)
      : createCapabilityRuntime({
          resolve: async (actor, connectionId) =>
            (await connectionAvailable(actor, connectionId)) ? connector : null,
          record: async () => {
            // The synthetic pilot does not export capability telemetry.
          },
        });
    if (simulation) {
      stockRefresh = createStockRefreshService({
        database: db,
        capabilities,
        log: failureLog,
      });
      resources.add(stockRefresh.close);
    }
    const inventory = simulation
      ? await createInventoryScenario({
          commerce,
          capabilities,
          operator,
          manifest,
        })
      : null;
    // Scheduled detection, as the sync worker runs it, plus the links a merchant reviews.
    const detectionErrors = [];
    const scheduled = simulation
      ? createScheduledDetection({
          internalOrdersEnabled: createSalesTenantRelease(observability),
          ...detectionTiming,
          database: db,
          capabilities,
          category: (provider) =>
            provider === 'luma-erp'
              ? 'erp'
              : (installations.providerCatalog.get(provider)?.category ?? null),
          detection: () => detection,
          log: (message, error) => {
            detectionErrors.push({ message, error: error?.message ?? null });
            failureLog(message, error);
          },
        })
      : null;
    if (scheduled) {
      resources.add(scheduled.close);
      orderRefresh = scheduled.refreshOrder;
    }
    const links = simulation
      ? createStockLinks({ commerce, operator, manifest })
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
        if (inventory?.monitor.matches(incident))
          return inventory.monitor.verifier.evaluate(actor, incident);
        if (scheduled?.verifier.handles(incident))
          return scheduled.verifier.evaluate(actor, incident);
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
    const processClient = temporal
      ? await createProcessClient(
          { ...temporal, taskQueue: `${temporal.taskQueue}-procurement` },
          identity.service,
        )
      : undefined;
    if (processClient) resources.add(processClient.close);
    const mailboxRuntime = simulation
      ? createInstalledMessageRuntime({
          ...installedOptions,
          record: async () => undefined,
        })
      : undefined;
    const application = createApplicationServices({
      observability,
      ...(modelGateway ? { modelGateway } : {}),
      ...(supplierExtraction ? { supplierExtraction } : {}),
      ...(processClient ? { replenishmentTransport: processClient } : {}),
      database: db,
      identity: identity.service,
      execution: { kind: 'enabled', effects },
      verifier,
      decisionSources: installations.decisionSources(),
      providerCatalog: installations.providerCatalog,
      workflowSources: installations.registry.workflowSources(),
      actionPermission: installations.registry.actionPermission,
      ...(detectionTiming.followUps
        ? { followUps: detectionTiming.followUps }
        : {}),
      ...(simulation ? { refreshStock } : {}),
      ...(simulation
        ? {
            purchasing: {
              runtime: createInstalledPurchaseOrderRuntime(installedOptions),
              installations,
            },
            returns: {
              runtime: createInstalledReturnRuntime(installedOptions),
              installations,
            },
          }
        : {}),
      // Simulated mailboxes are read through the installed capability runtime, as in the worker.
      ...(simulation
        ? {
            messaging: {
              installations,
              // Replies are sent through the same runtime, as in the API and worker.
              reader: mailboxRuntime,
              sender: mailboxRuntime,
              log: failureLog,
            },
          }
        : {}),
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
    orderPlans = application.http.orders;
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
    const metricEvents =
      role === 'api' ? createMetricListener(settings.databaseUrl) : undefined;
    if (metricEvents) resources.add(metricEvents.close);
    const app =
      role === 'api'
        ? buildApp(
            // Failed requests and background sync errors print to the pilot console.
            { logger: { level: 'error' } },
            {
              observability,
              identity: identity.service,
              settings: identity.settings,
              roles: identity.roles((tenantId) =>
                installations.apps.permissions(tenantId),
              ),
              trustedOrigins: settings.trustedOrigins,
              ...application.http,
              metricEvents,
              desk,
              playbooks: library,
              connections,
              sync: createCommerceSyncService(
                db,
                identity.service,
                connections,
                observability,
              ),
              apps: installations.apps,
              appRegistry: installations.registry,
              providerCatalog: installations.providerCatalog,

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
      const mailTimer = setInterval(() => {
        void identity.mailDelivery
          .drain()
          .catch(() => app.log.error('Email delivery pass failed'));
      }, 5000);
      mailTimer.unref();
      app.addHook('onClose', async () => {
        clearInterval(mailTimer);
        await identity.mailDelivery.drain();
      });
      if (inventory) {
        const base = '/v1/organizations/:organizationId/simulator/inventory';
        // Pilot-only routes declare the access the guard enforces, like contract routes.
        const read = { config: { access: { permission: 'issues.read' } } };
        app.get(base, read, (request) =>
          inventory.status(request.tenantContext, detection.exceptions),
        );
        app.post(
          `${base}/check`,
          { config: { access: { permission: 'issues.manage' } } },
          (request) => inventory.check(request.tenantContext, detection),
        );
        app.get(
          '/v1/organizations/:organizationId/simulator/cases',
          read,
          (request) =>
            lumaCases(request.tenantContext, {
              detection,
              workflows: application.caseWorkflows,
              manifest,
              webOrigin: settings.baseURL,
            }),
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
            permission: 'actions.propose',
          }),
        now: Date.now,
      })(await context(), exceptionId);
    }

    // Support changes order quantities in Luma when a simulated customer asks for it.
    const quantityChanges = simulation
      ? createQuantityChanges({ commerce, application, operator, manifest })
      : null;

    // The merchant's workflow setup for the simulator demo, run in the API process.
    const demo =
      simulation && role === 'api'
        ? createWorkflowDemo({ application, manifest, owner: context })
        : null;

    const replenishmentWorker =
      temporal && role === 'worker'
        ? await createReplenishmentWorker(
            temporal,
            application.replenishment,
            pool,
            identity.service,
            application.codeProcesses,
            application.caseWorkflows,
            application.coordination,
          )
        : undefined;
    if (replenishmentWorker) resources.add(replenishmentWorker.close);
    if (runtime && replenishmentWorker) {
      const createWorker = runtime.createWorker;
      runtime.createWorker = async () => {
        const worker = await createWorker();

        return {
          run: () => Promise.all([worker.run(), replenishmentWorker.run()]),
          shutdown: () => {
            worker.shutdown();
            replenishmentWorker.shutdown();
          },
          close: worker.close,
        };
      };
    }

    /** Runs one supplier follow-up pass, as the background worker does. */
    const followUp = async () => {
      await pool.query('SELECT purge_expired_procurement_communications(200)');
      const { rows } = await pool.query(
        'SELECT tenant_id,principal_id FROM procurement_submission_scopes()',
      );
      for (const row of rows)
        await application.commitments.tick(
          await identity.service.resolveWorkflowContext(
            row.principal_id,
            row.tenant_id,
            'supplier-follow-up',
          ),
        );
    };
    /**
     * Runs mailbox reading passes as the sync worker does, until no mailbox is due or `passes`
     * ran. Message text past its retention is removed first.
     */
    const readMailboxes = async ({ passes = 5 } = {}) => {
      const sync = application.messaging.sync;
      if (!sync) return;
      await pool.query('SELECT purge_expired_messaging(200)');
      for (let pass = 0; pass < passes; pass++) {
        const scopes = await sync.scopes();
        if (!scopes.length) break;
        for (const scope of scopes) await sync.tick(scope);
      }
    };
    if (role === 'worker' && simulation) {
      const timer = setInterval(() => {
        followUp().catch((error) =>
          console.error('Supplier follow-up failed; retrying.', error),
        );
      }, 10_000);
      resources.add(() => clearInterval(timer));
      const mailboxTimer = setInterval(() => {
        readMailboxes({ passes: 1 }).catch((error) =>
          console.error('Reading mailboxes failed; retrying.', error),
        );
      }, 10_000);
      resources.add(() => clearInterval(mailboxTimer));
    }

    return {
      app,
      runtime,
      capabilities,
      replenishment: application.replenishment,
      caseWorkflows: application.caseWorkflows,
      /** Human tasks and event waits for process workflows, as the worker coordinates them. */
      coordination: application.coordination,
      procurement: application.procurement,
      commitments: application.commitments,
      procurementContext: application.http.procurementContext,
      decisions: application.http.decisions,
      followUp,
      /** The operations inbox, its replies and a `sync()` that reads due mailboxes now. */
      messaging: {
        service: application.messaging.service,
        replies: application.messaging.replies,
        sync: readMailboxes,
      },
      context,
      operator,
      detection,
      desk,
      safety,
      playbooks,
      provider: () => readJson(path),
      /**
       * Runs commerce sync passes like the sync worker, then the inventory check. `refresh`
       * makes every stream due now instead of waiting for its next scheduled read.
       */
      observe: async ({ passes = 30, refresh = true, check = true } = {}) => {
        if (!simulation) return;
        if (refresh)
          for (const stream of await syncStore.streams(manifest.organizationId))
            await syncStore.command(
              manifest.organizationId,
              stream.id,
              { kind: 'resume' },
              stream.principalId,
            );
        for (let pass = 0; pass < passes; pass++) {
          const scopes = await syncRunner.scopes();
          if (!scopes.includes(manifest.organizationId)) {
            // Bulk exports finish asynchronously; wait for them instead of stopping.
            const waiting = (await syncStore.streams(manifest.organizationId))
              .filter(
                (item) =>
                  item.scan?.waitingForExport && !item.paused && !item.blocked,
              )
              .map((item) => Date.parse(item.dueAt));
            if (!waiting.length) break;
            await delay(
              Math.min(5000, Math.max(100, Math.min(...waiting) - Date.now())),
            );
            continue;
          }
          await syncRunner.tick(manifest.organizationId);
        }
        if (check) await inventory.check(await operator(), detection);
      },
      /** Links the next batch of the merchant's reviewed SKUs and shop locations. */
      link: async () => links?.pass(),
      /** Turns on demo workflows, suppliers and stock rules once their records are imported. */
      demo: async () => demo?.pass(),
      /** Carries simulated customers' quantity requests into Luma's order records. */
      quantityChanges: async () => quantityChanges?.pass(),
      /** Runs one scheduled detection and verification pass, as the sync worker does. */
      detect: async () => {
        if (scheduled) await scheduled.tick(await operator());
      },
      detectionErrors,
      /** Stored-state reads that choose what scheduled detection checks. */
      detectionSources: scheduled?.sources ?? null,
      /** The explicit inventory scenario, whose cases the scheduled monitor does not own. */
      inventoryScenario: inventory?.monitor ?? null,
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
