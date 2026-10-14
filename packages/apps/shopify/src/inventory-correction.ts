import { createHash } from 'node:crypto';

import type { AppFactoryContext } from '@luma/app-host';
import { createAuditLog } from '@luma/audit/composition';
import type {
  EffectRegistry,
  InstallationCapability,
  InstallationService,
} from '@luma/connections';
import { ConnectorError } from '@luma/connections';
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
import { IdentityError, requirePermission } from '@luma/identity';
import { createNativePublicationFence } from '@luma/inventory/composition';
import { canonicalJson } from '@luma/platform';
import { createPolicies } from '@luma/policies/composition';
import { z } from 'zod';

import {
  type CorrectionRun,
  createInventoryCorrection,
  verifyCorrection,
} from './application/inventory-correction.js';
import {
  correctionBlocker,
  correctionCapabilities,
} from './domain/inventory-correction.js';
import { createInventoryCorrectionProvider } from './infrastructure/inventory-correction-provider.js';
import { createCorrectionQuery } from './infrastructure/inventory-correction-query.js';
import { createCorrectionStore } from './infrastructure/inventory-correction-store.js';
import { readInventoryWriteReceipts } from './infrastructure/inventory-write-store.js';
import { shopifyRequestBudget } from './infrastructure/request-budget.js';

/** Composes Shopify correction with the platform's persistent Action Admission, policy and audit services. */
export function createShopifyInventoryCorrection(
  context: AppFactoryContext,
  installations: InstallationService,
  fetch?: typeof globalThis.fetch,
) {
  const publicationFence = createNativePublicationFence(
    context.database,
    context.refreshContext,
  );
  const query = createCorrectionQuery(
    context.database,
    context.sourceAuthority,
    (tenantId) =>
      context.featureEnabled?.(tenantId, 'purchasing-stock-booking') ??
      Promise.resolve(false),
  );
  const operation = {
    app: 'shopify',
    permission: 'shopify:inventory_corrections.apply',
    scopes: ['inventory.read'],
  } as const;
  const store = createCorrectionStore(context.database);
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
    capability: InstallationCapability = 'inventory.read',
  ) {
    const version = await context.requireInstalled(tenant, 'shopify');
    const summary = (await installations.list(tenant)).find(
      (value) => value.id === connectionId,
    );
    if (
      !summary ||
      summary.appId !== 'shopify' ||
      summary.provider !== 'shopify' ||
      summary.target.kind !== 'shopify' ||
      summary.appInstallationVersion !== version
    )
      throw new IdentityError(
        404,
        'NOT_FOUND',
        'Shopify connection not found.',
      );
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
    capability: InstallationCapability = 'inventory.read',
    eligible?: () => Promise<boolean>,
    nativeRun?: CorrectionRun,
    allowInactiveStorage = false,
  ) {
    const current = await credential(tenant, connectionId, capability);
    const shop = current.connection.target.shop!;
    const transport =
      simulationTransport(current.connection, context.simulation) ?? fetch;

    return createInventoryCorrectionProvider({
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
      ...(eligible ? { eligible } : {}),
      accessToken: async () => {
        const fresh = await credential(tenant, connectionId, capability);
        if (fresh.connection.target.shop !== shop)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Connection changed. Refresh inventory details.',
          );

        return fresh.credentials.token;
      },
      ...(nativeRun?.before.source.nativeAllocation
        ? {
            allowInactiveStorage: true,
            dispatchFence: async <T>(operation: () => Promise<T>) => {
              let started = false;
              try {
                return await publicationFence(
                  tenant,
                  nativeRun.before.source.nativeAllocation!,
                  () => {
                    started = true;

                    return operation();
                  },
                );
              } catch (error) {
                if (!started)
                  throw new ConnectorError({
                    code: 'conflict',
                    effect: 'none',
                    retry: 'never',
                    dispatch: 'not_dispatched',
                  });
                throw error;
              }
            },
            beforeDispatch: () =>
              context.database.transaction(tenant.tenantId, async (tx) => {
                const binding = nativeRun.before.source.nativeAllocation!;
                await tx.query(
                  'INSERT INTO shopify_native_stock_replicas(tenant_id,run_id,connection_id,sku_id,location_id,unit,scope_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
                  [
                    tenant.tenantId,
                    nativeRun.id,
                    connectionId,
                    binding.skuId,
                    binding.locationId,
                    binding.unit,
                    binding.scope.version,
                  ],
                );
              }),
          }
        : nativeRun?.target.receipt
          ? {
              allowInactiveStorage,
              dispatchFence: async <T>(operation: () => Promise<T>) => {
                let started = false;
                try {
                  return await context.database.transaction(
                    tenant.tenantId,
                    async (tx) => {
                      await tx.query(
                        'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
                        [`procurement:${tenant.tenantId}`],
                      );
                      await tx.query(
                        `SELECT scope.location_id FROM inventory_stock_ownership_scopes scope JOIN procurement_purchase_orders o ON o.tenant_id=scope.tenant_id CROSS JOIN LATERAL jsonb_array_elements(o.document->'lines') line WHERE scope.tenant_id=$1 AND o.id=$2 AND line->>'id'=$3 AND scope.location_id=(line->>'locationId')::uuid FOR SHARE OF scope`,
                        [
                          tenant.tenantId,
                          nativeRun.target.receipt!.purchaseOrderId,
                          nativeRun.target.receipt!.lineId,
                        ],
                      );
                      const source = await query.authority(
                        tenant,
                        nativeRun.target,
                      );
                      if (
                        source.source.revision !==
                        nativeRun.before.source.revision
                      )
                        throw new IdentityError(
                          409,
                          'CONFLICT',
                          'Receipt stock evidence changed.',
                        );
                      started = true;

                      return await operation();
                    },
                  );
                } catch (error) {
                  if (!started)
                    throw new ConnectorError({
                      code: 'conflict',
                      effect: 'none',
                      retry: 'never',
                      dispatch: 'not_dispatched',
                    });
                  throw error;
                }
              },
            }
          : { allowInactiveStorage }),
      record: (evidence) => store.record(tenant, connectionId, evidence),
      receipts: (inventoryItemId, locationId) =>
        readInventoryWriteReceipts(context.database, tenant, connectionId, [
          { inventoryItemId, locationId },
        ]),
    });
  }

  const authorize = async (tenant: TenantContext, connectionId: string) => {
    const current = await credential(tenant, connectionId);

    return current.connection.permissions.filter((capability) =>
      current.connection.granted.includes(capability),
    );
  };
  const read = async (
    tenant: TenantContext,
    target: CorrectionRun['target'],
    receiptProof = false,
  ) => {
    // Stock moves while people decide; read stale sources again before judging them.
    await context.refreshStock?.(tenant, target.positionId);
    const authority = await query.authority(tenant, target, receiptProof);
    const snapshot = await (
      await provider(
        tenant,
        target.connectionId,
        'inventory.read',
        undefined,
        undefined,
        !!target.nativeAllocation,
      )
    ).read(authority.inventoryItemId, authority.locationId);
    // The source revision identifies the authoritative ERP value, independent of which read
    // reported it; freshness is checked from `observedAt`.
    const revision = createHash('sha256')
      .update(
        canonicalJson({
          targetRevision: snapshot.targetRevision,
          source: authority.source.revision,
        }),
      )
      .digest('hex');

    return {
      ...snapshot,
      source: authority.source,
      revision,
      product: await query.product(tenant, target),
    };
  };
  const effects: EffectRegistry = {
    async resolve(tenant, intent) {
      const capability = correctionCapabilities.find(
        (value) => value === intent.capability,
      );
      if (!capability) return null;
      const run = await store.get(tenant, intent.target.id);
      if (
        !run ||
        run.before.available === null ||
        canonicalJson(intent) !== canonicalJson(run.action)
      )
        return null;

      const expectedAvailable = run.before.available;
      const runRuntime = createCapabilityRuntime({
        record: async () => {
          /* Provider evidence and execution audit retain the attempt. */
        },
        async resolve(currentTenant, connectionId) {
          await authorize(currentTenant, connectionId);
          const scoped = await provider(
            currentTenant,
            connectionId,
            capability,
            async () => {
              const source = await query.authority(currentTenant, run.target);
              const age = Date.now() - Date.parse(source.source.observedAt);

              return (
                age >= 0 &&
                age < 5 * 60_000 &&
                source.source.revision === run.before.source.revision &&
                source.inventoryItemId === run.before.inventoryItemId &&
                source.locationId === run.before.locationId
              );
            },
            run,
          );

          return {
            tenantId: currentTenant.tenantId,
            id: connectionId,
            provider: 'shopify',
            status: 'active',
            adapterVersion: 'shopify-inventory/1',
            mechanism: 'api',
            executor: { kind: 'connector', id: 'shopify-inventory/1' },
            capabilities: scoped.capabilities,
          };
        },
      });

      return runRuntime
        .effects({
          capability,
          map: async () => ({
            inventoryItemId: run.before.inventoryItemId,
            locationId: run.before.locationId,
            expectedRevision: run.before.targetRevision,
            expectedAvailable,
            available: run.before.source.available,
          }),
          checkPreconditions: async () => {
            const granted = await authorize(tenant, run.target.connectionId);
            const current = await read(tenant, run.target);

            return (
              current.revision === run.before.revision &&
              !correctionBlocker(current, run.choice, granted, new Date())
            );
          },
          verify: async () =>
            verifyCorrection(run, await read(tenant, run.target, true)),
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
  const service = createInventoryCorrection({
    store,
    candidates: query.candidates,
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
        id: 'shopify-inventory-correction',
        version: run.choice.capability,
        generation: {
          kind: 'manual',
          reference: 'shopify-inventory-correction/1',
        },
        steps: {
          correct: {
            capability: run.choice.capability,
            capabilityVersion: '0',
            targetKind: 'shopify_inventory_correction',
            minimumRisk: 'medium',
          },
        },
      });
      await provisioning.bind(tenant, {
        runId: run.id,
        stepId: 'correct',
        tenantId: tenant.tenantId,
        principalId: run.action.proposedBy.id,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        subject: { kind: 'shopify_inventory_correction', id: run.id },
        eligibilityValidUntil: run.action.expiresAt,
        action: run.action,
      });
    },
  });

  return {
    ...service,
    /** Resolves immutable manual receipt evidence and the live stock baseline before governed approval. */
    async receiptPreview(tenant: TenantContext, input: unknown) {
      tenant = await context.refreshContext(tenant);
      requirePermission(tenant, 'procurement.manage');
      await context.requirePermission(tenant, operation);
      const request = z
        .object({
          requestId: z.string().uuid(),
          purchaseOrderId: z.string().uuid(),
          lineId: z.string().uuid(),
        })
        .strict()
        .parse(input);
      const existing = await store.get(tenant, request.requestId);
      if (existing) {
        if (
          existing.target.receipt?.purchaseOrderId !==
            request.purchaseOrderId ||
          existing.target.receipt.lineId !== request.lineId
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'This request belongs to another receipt.',
          );

        return service.preview(tenant, {
          requestId: request.requestId,
          ...existing.target,
        });
      }
      const receipt = await query.receipts.evidence(
        tenant,
        request.purchaseOrderId,
        request.lineId,
      );
      if (receipt.quantity <= 0)
        throw new IdentityError(
          409,
          'CONFLICT',
          'All undamaged units in this receipt have already been booked.',
        );
      await context.refreshStock?.(tenant, receipt.positionId);
      const target = {
        positionId: receipt.positionId,
        connectionId: receipt.connectionId,
        sourceConnectionId: receipt.connectionId,
        receipt: {
          purchaseOrderId: request.purchaseOrderId,
          lineId: request.lineId,
          commitmentId: receipt.receiptId,
          damagedCommitmentId: receipt.damagedId,
          baselineAvailable: 0,
          quantity: receipt.quantity,
          cumulativeGood: receipt.cumulativeGood,
        },
      };
      const mapping = await query.authority(tenant, target);
      const baseline = await (
        await provider(tenant, receipt.connectionId)
      ).read(mapping.inventoryItemId, mapping.locationId);
      if (baseline.available === null)
        throw new IdentityError(
          409,
          'CONFLICT',
          'Read Shopify stock before booking this receipt.',
        );
      target.receipt.baselineAvailable = baseline.available;

      return service.preview(tenant, {
        requestId: request.requestId,
        ...target,
      });
    },
    /** Lists persisted receipt stock work, including uncertain attempts, without proposing another write. */
    async receiptState(tenant: TenantContext, input: unknown) {
      tenant = await context.refreshContext(tenant);
      await context.requirePermission(tenant, operation);
      requirePermission(tenant, 'procurement.read');
      const request = z
        .object({
          purchaseOrderId: z.string().uuid(),
          lineId: z.string().uuid(),
        })
        .strict()
        .parse(input);
      const enabled =
        (await context.featureEnabled?.(
          tenant.tenantId,
          'purchasing-stock-booking',
        )) ?? false;
      if (!enabled) return { enabled, runs: [] };
      const ids = await context.database.transaction(
        tenant.tenantId,
        async (tx) =>
          (
            await tx.query<{ id: string }>(
              `SELECT id FROM shopify_inventory_corrections WHERE tenant_id=$1 AND document->'target'->'receipt'->>'purchaseOrderId'=$2 AND document->'target'->'receipt'->>'lineId'=$3 ORDER BY created_at DESC,id LIMIT 20`,
              [tenant.tenantId, request.purchaseOrderId, request.lineId],
            )
          ).rows,
      );
      const runs = await Promise.all(
        ids.map((row) => service.check(tenant, { id: row.id })),
      );

      return { enabled, runs };
    },
  };
}
