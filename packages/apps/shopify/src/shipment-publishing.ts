import { randomUUID } from 'node:crypto';

import type { AppFactoryContext } from '@luma/app-host';
import { createAuditLog } from '@luma/audit/composition';
import type {
  EffectRegistry,
  InstallationCapability,
  InstallationService,
} from '@luma/connections';
import {
  createCapabilityRuntime,
  simulationTransport,
} from '@luma/connections/adapters';
import {
  createAdmission,
  createAdmissionStore,
  createExecution,
  parseAction,
} from '@luma/execution/composition';
import type { TenantContext } from '@luma/identity';
import { canonicalJson, conflict, notFound } from '@luma/platform';
import { createPolicies, policyAudit } from '@luma/policies/composition';

import {
  createShipmentPublishing,
  type PublishingRun,
  verifyPublishing,
} from './application/shipment-publishing.js';
import {
  publishingBlocker,
  publishingCapabilities,
  verifiedPublishingFulfillment,
} from './domain/shipment-publishing.js';
import { shopifyRequestBudget } from './infrastructure/request-budget.js';
import { createPublishingProvider } from './infrastructure/shipment-publishing-provider.js';
import { createPublishingStore } from './infrastructure/shipment-publishing-store.js';

/** Composes Shopify publishing with the platform's persistent Action Admission, policy and audit services. */
export function createShopifyPublishing(
  context: AppFactoryContext,
  installations: InstallationService,
  fetch?: typeof globalThis.fetch,
) {
  const enabled = (tenant: TenantContext) =>
    context.featureEnabled?.(tenant.tenantId, 'shopify-shipment-publishing') ??
    Promise.resolve(false);
  const operation = {
    app: 'shopify',
    permission: 'shopify:shipment_publishing.run',
    scopes: ['orders.read', 'fulfillment.read'],
  } as const;
  const store = createPublishingStore(context.database);
  const audit = createAuditLog(context.database);
  const provisioning = createAdmissionStore(context.database);
  const policies = createPolicies(
    context.database,
    context.refreshContext,
    policyAudit(audit),
  );

  async function credential(
    tenant: TenantContext,
    connectionId: string,
    capability: InstallationCapability = 'fulfillment.read',
  ) {
    const version = await context.requireInstalled(tenant, 'shopify');
    const current = await installations.credential(
      tenant,
      connectionId,
      capability,
    );
    if (
      current.connection.appId !== 'shopify' ||
      current.connection.provider !== 'shopify' ||
      current.connection.target.kind !== 'shopify' ||
      current.connection.appInstallationVersion !== version
    )
      throw notFound('Shopify connection not found.');

    return current;
  }

  async function provider(
    tenant: TenantContext,
    connectionId: string,
    capability: InstallationCapability = 'fulfillment.read',
  ) {
    const current = await credential(tenant, connectionId, capability);
    const shop = current.connection.target.shop!;
    // Simulated connections must reach the simulator, never a live shop.
    const transport =
      simulationTransport(current.connection, context.simulation) ?? fetch;

    return createPublishingProvider({
      budget: shopifyRequestBudget(
        context,
        current.connection,
        'foreground',
        tenant.dataRegion,
      ),
      tenantId: tenant.tenantId,
      connectionId,
      shop,
      ...(transport ? { fetch: transport } : {}),
      accessToken: async () => {
        const fresh = await credential(tenant, connectionId, capability);
        if (fresh.connection.target.shop !== shop)
          throw conflict('Connection changed. Refresh fulfillment details.');

        return fresh.credentials.token;
      },
      load: (id) => store.get(tenant, id),
      dispatch: (run) => dispatch(tenant, run.target, run.choice.source),
      sent: (id) => store.sent(tenant, id),
      enabled: () => enabled(tenant),
      granted: () => authorize(tenant, connectionId),
      record: (evidence) => store.record(tenant, connectionId, evidence),
    });
  }

  const authorize = async (tenant: TenantContext, connectionId: string) => {
    const current = await credential(tenant, connectionId);

    return current.connection.permissions.filter((capability) =>
      current.connection.granted.includes(capability),
    );
  };

  async function dispatch(
    tenant: TenantContext,
    target: PublishingRun['target'],
    source: PublishingRun['choice']['source'],
  ) {
    const version = await context.requireInstalled(tenant, 'starshipit');
    await context.requirePermission(tenant, {
      app: 'starshipit',
      scopes: ['orders.read', 'fulfillment.read'],
    });
    // Read-only metadata checks avoid running Shopify OAuth refresh for another provider's credentials.
    const connection = (await installations.list(tenant)).find(
      (item) => item.id === source.downstreamConnectionId,
    );
    if (
      !connection ||
      connection.status !== 'active' ||
      connection.appId !== 'starshipit' ||
      connection.provider !== 'starshipit' ||
      connection.appInstallationVersion !== version ||
      !connection.permissions.includes('fulfillment.read') ||
      !connection.granted.includes('fulfillment.read')
    )
      throw conflict(
        'Choose an installed, readable downstream fulfillment source.',
      );

    return (
      context.shipmentDispatchEvidence?.(tenant, { ...target, ...source }) ??
      null
    );
  }

  const read = async (
    tenant: TenantContext,
    target: PublishingRun['target'],
    source: PublishingRun['choice']['source'],
  ) =>
    (await provider(tenant, target.connectionId)).read(
      target.orderId,
      await dispatch(tenant, target, source),
    );
  const runtime = createCapabilityRuntime({
    record: async () => {
      /* Execution records and provider evidence retain each attempt. */
    },
    async resolve(tenant, connectionId) {
      await authorize(tenant, connectionId);
      const capabilities = {};
      for (const capability of publishingCapabilities) {
        const handler = (
          await provider(tenant, connectionId, 'fulfillment.read')
        ).capabilities[capability];
        Object.assign(capabilities, { [capability]: handler });
      }

      return {
        tenantId: tenant.tenantId,
        id: connectionId,
        provider: 'shopify',
        status: 'active',
        adapterVersion: 'shopify-fulfillment/1',
        mechanism: 'api',
        executor: { kind: 'connector', id: 'shopify-fulfillment/1' },
        capabilities,
      };
    },
  });
  const effects: EffectRegistry = {
    async resolve(tenant, intent) {
      const capability = publishingCapabilities.find(
        (value) => value === intent.capability,
      );
      if (!capability) return null;
      const run = await store.get(tenant, intent.target.id);
      if (!run || canonicalJson(intent) !== canonicalJson(run.action))
        return null;

      return runtime
        .effects({
          capability,
          map: async () => ({
            operationId: run.id,
            orderId: run.target.orderId,
            expectedRevision: run.before.revision,
          }),
          checkPreconditions: async () => {
            const granted = await authorize(tenant, run.target.connectionId);
            const current = await read(tenant, run.target, run.choice.source);

            return (
              (await enabled(tenant)) &&
              current.revision === run.before.revision &&
              !publishingBlocker(current, run.choice, granted)
            );
          },
          verify: async () => {
            await store.fence(tenant, run.id);

            const current = await read(tenant, run.target, run.choice.source);
            const fulfillmentId = verifiedPublishingFulfillment(
              run.before,
              run.choice,
              current,
            );
            if (fulfillmentId)
              await store.record(tenant, run.target.connectionId, {
                id: randomUUID(),
                kind: 'observation',
                observedAt: current.observedAt,
                document: {
                  kind: 'verified_publication',
                  operationId: run.id,
                  fulfillmentId,
                  observationId: current.id,
                  revision: current.revision,
                },
              });

            return verifyPublishing(run, current);
          },
        })
        .resolve(tenant, intent);
    },
  };
  const engine = createExecution(
    context.database,
    policies,
    audit,
    effects,
    context.refreshContext,
  );
  const admission = createAdmission({
    repository: provisioning,
    execution: engine,
    refreshContext: context.refreshContext,
    eligible: (tenant, step) => service.eligible(tenant, step),
  });
  const service = createShipmentPublishing({
    store,
    admission,
    policies,
    effects,
    read,
    authorize,
    enabled,
    permission: {
      require: (tenant) => context.requirePermission(tenant, operation),
      allowed: (tenant) => context.hasPermission(tenant, operation),
    },
    refreshContext: context.refreshContext,
    now: () => new Date(),
    hash: (action) => parseAction(action).hash,
    async bind(tenant, run) {
      const artifact = await provisioning.activate(tenant, {
        id: 'shopify-shipment-publishing',
        version: run.choice.capability,
        generation: {
          kind: 'manual',
          reference: 'shopify-shipment-publishing/1',
        },
        steps: {
          publish: {
            capability: run.choice.capability,
            capabilityVersion: '0',
            targetKind: 'shopify_shipment_publication',
            minimumRisk: 'high',
          },
        },
      });
      await provisioning.bind(tenant, {
        runId: run.id,
        stepId: 'publish',
        tenantId: tenant.tenantId,
        principalId: run.action.proposedBy.id,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        subject: { kind: 'order', id: run.target.orderId },
        eligibilityValidUntil: run.action.expiresAt,
        action: run.action,
      });
    },
  });

  return service;
}
