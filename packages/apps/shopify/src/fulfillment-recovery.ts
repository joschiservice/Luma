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
import { IdentityError } from '@luma/identity';
import { canonicalJson } from '@luma/platform';
import { createPolicies } from '@luma/policies/composition';

import {
  createFulfillmentRecovery,
  type RecoveryRun,
  verifyRecovery,
} from './application/fulfillment-recovery.js';
import {
  recoveryBlocker,
  recoveryCapabilities,
} from './domain/fulfillment-recovery.js';
import { createFulfillmentProvider } from './infrastructure/fulfillment-recovery-provider.js';
import { createRecoveryStore } from './infrastructure/fulfillment-recovery-store.js';

/** Composes Shopify recovery with the platform's persistent Action Admission, policy and audit services. */
export function createShopifyRecovery(
  context: AppFactoryContext,
  installations: InstallationService,
  fetch?: typeof globalThis.fetch,
) {
  const operation = {
    app: 'shopify',
    permission: 'shopify:fulfillment_recovery.run',
    scopes: ['fulfillment.read'],
  } as const;
  const store = createRecoveryStore(context.database);
  const audit = createAuditLog(context.database);
  const provisioning = createAdmissionStore(context.database);
  const policies = createPolicies(
    context.database,
    context.refreshContext,
    async (event) => {
      const value = event.document;
      await audit.append({
        id: value.id,
        tenantId: value.tenantId,
        eventKey: value.id,
        eventType: event.type,
        schemaVersion: 1,
        occurredAt:
          'evaluatedAt' in value ? value.evaluatedAt : value.createdAt,
        actor: {
          kind: 'user',
          id: 'actorId' in value ? value.actorId : value.approverId,
        },
        correlationId: value.correlationId,
        proposalId: value.proposalId,
        actionHash: value.actionHash,
        policyDecisionId: 'actorId' in value ? value.id : value.decisionId,
        evidenceRefs: [],
        details: { outcome: value.outcome, policyVersion: value.policyVersion },
      });
    },
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
      throw new IdentityError(
        404,
        'NOT_FOUND',
        'Shopify connection not found.',
      );

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

    return createFulfillmentProvider({
      tenantId: tenant.tenantId,
      connectionId,
      shop,
      ...(transport ? { fetch: transport } : {}),
      accessToken: async () => {
        const fresh = await credential(tenant, connectionId, capability);
        if (fresh.connection.target.shop !== shop)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Connection changed. Refresh fulfillment details.',
          );

        return fresh.credentials.token;
      },
      record: (evidence) => store.record(tenant, connectionId, evidence),
    });
  }

  const authorize = async (tenant: TenantContext, connectionId: string) => {
    const current = await credential(tenant, connectionId);

    return current.connection.permissions.filter((capability) =>
      current.connection.granted.includes(capability),
    );
  };
  const read = async (tenant: TenantContext, target: RecoveryRun['target']) =>
    (await provider(tenant, target.connectionId)).read(
      target.orderId,
      target.fulfillmentOrderId,
    );
  const runtime = createCapabilityRuntime({
    record: async () => {
      /* Execution records and provider evidence retain each attempt. */
    },
    async resolve(tenant, connectionId) {
      const granted = await authorize(tenant, connectionId);
      const capabilities = {};
      for (const capability of recoveryCapabilities) {
        if (!granted.includes(capability)) continue;
        const handler = (await provider(tenant, connectionId, capability))
          .capabilities[capability];
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
      const capability = recoveryCapabilities.find(
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
            orderId: run.target.orderId,
            fulfillmentOrderId: run.target.fulfillmentOrderId,
            expectedRevision: run.before.revision,
            ...('holdId' in run.choice ? { holdId: run.choice.holdId } : {}),
            ...('locationId' in run.choice
              ? { locationId: run.choice.locationId }
              : {}),
          }),
          checkPreconditions: async () => {
            const granted = await authorize(tenant, run.target.connectionId);
            const current = await read(tenant, run.target);

            return (
              current.revision === run.before.revision &&
              !recoveryBlocker(current, run.choice, granted)
            );
          },
          verify: async () =>
            verifyRecovery(run, await read(tenant, run.target)),
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
  const service = createFulfillmentRecovery({
    store,
    admission,
    policies,
    effects,
    read,
    authorize,
    permission: {
      require: (tenant) => context.requirePermission(tenant, operation),
      allowed: (tenant) => context.hasPermission(tenant, operation),
    },
    refreshContext: context.refreshContext,
    now: () => new Date(),
    hash: (action) => parseAction(action).hash,
    async bind(tenant, run) {
      const artifact = await provisioning.activate(tenant, {
        id: 'shopify-fulfillment-recovery',
        version: run.choice.capability,
        generation: {
          kind: 'manual',
          reference: 'shopify-fulfillment-recovery/1',
        },
        steps: {
          recover: {
            capability: run.choice.capability,
            capabilityVersion: '0',
            targetKind: 'shopify_fulfillment',
            minimumRisk: 'medium',
          },
        },
      });
      await provisioning.bind(tenant, {
        runId: run.id,
        stepId: 'recover',
        tenantId: tenant.tenantId,
        principalId: run.action.proposedBy.id,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        subject: { kind: 'shopify_fulfillment', id: run.id },
        eligibilityValidUntil: run.action.expiresAt,
        action: run.action,
      });
    },
  });

  return service;
}
