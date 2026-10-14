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
  createOrderEdits,
  type OrderEditRun,
} from './application/order-edits.js';
import {
  type AuthoritativeLines,
  authoritativeLines,
  editOutcome,
  orderEditCapability,
  orderEditPermission,
  type OrderLineAuthority,
} from './domain/order-edits.js';
import {
  calculationDigest,
  createOrderEditProvider,
} from './infrastructure/order-edit-provider.js';
import { createOrderEditStore } from './infrastructure/order-edit-store.js';
import { shopifyRequestBudget } from './infrastructure/request-budget.js';

/** Stored authoritative reads older than this are reread before an edit judges them. */
const refreshAfterMs = 60_000;

/** Composes Shopify order quantity edits with the platform's Action Admission, policy and audit services. */
export function createShopifyOrderEdits(
  context: AppFactoryContext,
  installations: InstallationService,
  fetch?: typeof globalThis.fetch,
) {
  const operation = {
    app: 'shopify',
    permission: orderEditPermission,
    scopes: ['orders.read', 'fulfillment.read'],
  } as const;
  const store = createOrderEditStore(context.database);
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
    capability: InstallationCapability = 'orders.read',
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
    capability: InstallationCapability = 'orders.read',
  ) {
    const current = await credential(tenant, connectionId, capability);
    const shop = current.connection.target.shop!;
    // Simulated connections must reach the simulator, never a live shop.
    const transport =
      simulationTransport(current.connection, context.simulation) ?? fetch;

    return createOrderEditProvider({
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
        // Edits are judged against fulfillment work, so every call needs both reads.
        await credential(tenant, connectionId, 'fulfillment.read');
        const fresh = await credential(tenant, connectionId, capability);
        if (fresh.connection.target.shop !== shop)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Connection changed. Refresh the order.',
          );

        return fresh.credentials.token;
      },
      record: (evidence) => store.record(tenant, connectionId, evidence),
      fence: {
        reserve: (id) => store.reserve(tenant, id),
        send: (id) => store.send(tenant, id),
        finish: async (id, state) => {
          await store.finish(tenant, id, state);
          // Hints only speed up sync; scheduled scans still cover the order.
          if (state === 'accepted')
            await store.hint(tenant, connectionId, id).catch(() => undefined);
        },
      },
      eligible: (id, snapshot) => service.unchanged(tenant, id, snapshot),
    });
  }

  const authorize = async (tenant: TenantContext, connectionId: string) => {
    const current = await credential(tenant, connectionId);

    return current.connection.permissions.filter((capability) =>
      current.connection.granted.includes(capability),
    );
  };
  const read = async (tenant: TenantContext, target: OrderEditRun['target']) =>
    (await provider(tenant, target.connectionId)).read(target.orderId);
  const authority = async (
    tenant: TenantContext,
  ): Promise<OrderLineAuthority | null> => {
    const snapshot = await context.sourceAuthority?.read(tenant);
    const lines = snapshot?.groups.find(
      (group) => group.group === 'order_lines',
    );

    return snapshot && lines
      ? {
          revision: snapshot.revision,
          state: lines.state,
          connectionId: lines.connectionId,
        }
      : null;
  };

  const sourceLines = async (
    tenant: TenantContext,
    target: OrderEditRun['target'],
    sourceConnectionId: string,
  ): Promise<AuthoritativeLines | null> => {
    const stored = () =>
      context.sourceOrderLines?.(tenant, {
        connectionId: target.connectionId,
        orderId: target.orderId,
        sourceConnectionId,
      });
    let lines = await stored();
    // A propagated edit needs a fresh authoritative read, so a late decision rereads the order.
    if (
      lines &&
      context.refreshOrder &&
      Date.now() - Date.parse(lines.observedAt) > refreshAfterMs
    ) {
      await context.refreshOrder(tenant, lines.orderId);
      lines = await stored();
    }

    return lines
      ? authoritativeLines.parse({
          ...lines,
          lines: lines.lines.flatMap((line) =>
            /^gid:\/\/shopify\/LineItem\/\d+$/.test(line.externalId)
              ? [{ lineItemId: line.externalId, quantity: line.quantity }]
              : [],
          ),
        })
      : null;
  };

  /**
   * Proves an edit from independent reads only. A fence that never sent its commit is closed
   * first, so an interrupted dispatch can no longer send it.
   */
  async function verify(tenant: TenantContext, run: OrderEditRun) {
    const fence = await store.close(tenant, run.id);
    const edits = await provider(tenant, run.target.connectionId);
    const current = await edits.read(run.target.orderId);
    // Without a sent commit only the closed fence decides; no agreement can exist.
    const outcome = fence.sentAt
      ? editOutcome(
          run.lines,
          fence,
          await edits.proof(run.target.orderId, fence.sentAt),
          new Date(),
        )
      : fence.state === 'withheld'
        ? 'not_committed'
        : 'unknown';
    const passed =
      outcome === 'committed' &&
      current.complete &&
      !current.cancelled &&
      run.lines.every(
        (line) =>
          current.lines.find((item) => item.id === line.lineItemId)
            ?.currentQuantity === line.quantity,
      );
    if (passed)
      await store
        .hint(tenant, run.target.connectionId, run.id)
        .catch(() => undefined);

    return {
      outcome: passed
        ? ('passed' as const)
        : outcome === 'not_committed'
          ? ('failed' as const)
          : ('inconclusive' as const),
      observationRefs: [current.id],
      observedAt: current.observedAt,
      evaluatorVersion: 'shopify-order-edit/1',
    };
  }

  const runtime = createCapabilityRuntime({
    record: async () => {
      /* Execution records and provider evidence retain each attempt. */
    },
    async resolve(tenant, connectionId) {
      const granted = await authorize(tenant, connectionId);

      return {
        tenantId: tenant.tenantId,
        id: connectionId,
        provider: 'shopify',
        status: 'active',
        adapterVersion: 'shopify-order-edit/1',
        mechanism: 'api',
        executor: { kind: 'connector', id: 'shopify-order-edit/1' },
        capabilities: granted.includes(orderEditCapability)
          ? {
              [orderEditCapability]: (
                await provider(tenant, connectionId, orderEditCapability)
              ).handler,
            }
          : {},
      };
    },
  });
  const effects: EffectRegistry = {
    async resolve(tenant, intent) {
      if (intent.capability !== orderEditCapability) return null;
      const run = await store.get(tenant, intent.target.id);
      if (!run || canonicalJson(intent) !== canonicalJson(run.action))
        return null;

      return runtime
        .effects({
          capability: orderEditCapability,
          map: async () => ({
            operationId: run.id,
            orderId: run.target.orderId,
            expectedRevision: run.before.revision,
            restock: run.change.restock,
            lines: run.lines,
            calculationDigest: run.calculation
              ? calculationDigest(run.calculation)
              : null,
          }),
          checkPreconditions: async () =>
            service.unchanged(tenant, run.id, await read(tenant, run.target)),
          verify: () => verify(tenant, run),
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
  const service = createOrderEdits({
    store,
    admission,
    policies,
    effects,
    read,
    authority,
    sourceLines,
    authorize,
    calculate: async (tenant, target, lines, restock) =>
      (
        await (
          await provider(tenant, target.connectionId, orderEditCapability)
        ).calculate(target.orderId, lines, restock)
      ).calculation,
    digest: calculationDigest,
    permission: {
      require: (tenant) => context.requirePermission(tenant, operation),
      allowed: (tenant) => context.hasPermission(tenant, operation),
    },
    refreshContext: context.refreshContext,
    now: () => new Date(),
    hash: (action) => parseAction(action).hash,
    async bind(tenant, run) {
      const artifact = await provisioning.activate(tenant, {
        id: 'shopify-order-edit',
        version: orderEditCapability,
        generation: { kind: 'manual', reference: 'shopify-order-edit/1' },
        steps: {
          edit: {
            capability: orderEditCapability,
            capabilityVersion: '0',
            targetKind: 'shopify_order_edit',
            minimumRisk: 'medium',
          },
        },
      });
      await provisioning.bind(tenant, {
        runId: run.id,
        stepId: 'edit',
        tenantId: tenant.tenantId,
        principalId: run.action.proposedBy.id,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        subject: { kind: 'shopify_order_edit', id: run.id },
        eligibilityValidUntil: run.action.expiresAt,
        action: run.action,
      });
    },
  });

  return service;
}
