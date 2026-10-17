import { createHash } from 'node:crypto';

import {
  type StockProtectionPosition,
  stockProtectionQuerySchema,
  type StockProtectionSettings,
  stockProtectionSettingsSchema,
} from '@luma/api-contract';
import type { AppDefinition, AppFactoryContext } from '@luma/app-host';
import { createAuditLog } from '@luma/audit/composition';
import type {
  CapabilityHandler,
  EffectRegistry,
  InstallationCapability,
} from '@luma/connections';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import {
  createAdmission,
  createAdmissionStore,
  createExecution,
  createExecutionFailureReader,
  parseAction,
} from '@luma/execution/composition';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  requireChangesAllowed,
  requirePermission,
} from '@luma/identity';
import { canonicalJson, conflict, forbidden, notFound } from '@luma/platform';
import type { PolicyService, ProposedAction } from '@luma/policies';
import {
  createPolicies,
  createStockProtectionAdmission,
  createStockProtectionConsent,
  policyAudit,
} from '@luma/policies/composition';
import { z } from 'zod';

import type { CorrectionSnapshot } from './domain/inventory-correction.js';
import {
  heldQuantity,
  outsideHold,
  type ProtectionCandidate,
  protectionExclusion,
} from './domain/stock-protection.js';
import type { createInventoryCorrectionProvider } from './infrastructure/inventory-correction-provider.js';
import { createProtectionQuery } from './infrastructure/stock-protection-query.js';
import {
  createProtectionStore,
  type ProtectionAction,
  type ProtectionRecord,
} from './infrastructure/stock-protection-store.js';

const active = new Set([
  'pending',
  'held',
  'tightened',
  'releasing',
  'unknown',
]);
const stableId = (value: string) => {
  const hex = createHash('sha256').update(value).digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

type Target = {
  positionId: string;
  connectionId: string;
  sourceConnectionId: string;
};

/** Incident-owned protection uses persistent policy, admission, one-shot dispatch and fresh verification. */
export function createShopifyStockProtection(
  context: AppFactoryContext,
  deps: {
    read(
      tenant: TenantContext,
      target: Target,
      includeCollections?: boolean,
      precondition?: boolean,
    ): Promise<CorrectionSnapshot>;
    provider(
      tenant: TenantContext,
      connectionId: string,
      holdId: string,
      eligible: () => Promise<boolean>,
    ): Promise<ReturnType<typeof createInventoryCorrectionProvider>>;
    authorize(
      tenant: TenantContext,
      connectionId: string,
    ): Promise<InstallationCapability[]>;
  },
): NonNullable<AppDefinition['stockProtection']> {
  const store = createProtectionStore(context.database);
  const query = createProtectionQuery(context.database);
  const consent = createStockProtectionConsent(context.database, (value) =>
    stockProtectionSettingsSchema.parse(value),
  );
  const admit = createStockProtectionAdmission(context.database);
  const audit = createAuditLog(context.database);
  const provisioning = createAdmissionStore(context.database);
  const readFailure = createExecutionFailureReader(context.database);
  const now = () => new Date();
  const released = (tenantId: string) =>
    context.featureEnabled?.(tenantId, 'stock-protection') ??
    Promise.resolve(false);
  const operation = {
    app: 'shopify',
    permission: 'shopify:inventory_corrections.apply',
    scopes: ['inventory.read'],
  } as const;

  async function scope(tenant: TenantContext, manage = false) {
    const fresh = await context.refreshContext(tenant);
    if (
      fresh.tenantId !== tenant.tenantId ||
      fresh.actor.id !== tenant.actor.id
    )
      throw forbidden('Workspace access changed.');
    if (manage) {
      requireChangesAllowed(fresh);
      requirePermission(fresh, 'workspace.approval_policy.manage');
    } else requirePermission(fresh, 'inventory.read');

    return fresh;
  }

  async function configuration(
    tenant: TenantContext,
    record: ProtectionRecord,
  ) {
    return (
      (await consent.list(tenant)).find(
        (s) =>
          s.connectionId === record.view.connectionId &&
          s.sourceConnectionId === record.view.sourceConnectionId,
      ) ?? record.settings
    );
  }

  async function permitted(tenant: TenantContext, run: ProtectionAction) {
    if (
      !(await released(tenant.tenantId)) ||
      !(await context.hasPermission(tenant, operation))
    )
      return false;
    const record = await store.get(tenant, run.incidentId);
    if (
      !record ||
      record.principalId !== tenant.actor.id ||
      record.view.mode !== 'on'
    )
      return false;
    const settings = await configuration(tenant, record);
    const position = record.view.positions.find((p) => p.id === run.holdId);
    if (
      !position ||
      !active.has(position.status) ||
      settings.revision !== run.policyRevision
    )
      return false;
    if (
      run.operation === 'hold' &&
      (settings.mode !== 'on' ||
        record.view.stopNew ||
        record.view.releaseRequested ||
        record.view.state === 'released' ||
        +now() >= Date.parse(record.view.deadline))
    )
      return false;
    if (
      run.operation === 'release' &&
      !record.releaseHoldIds?.includes(run.holdId) &&
      !record.view.releaseRequested &&
      !(await query.recovered(tenant, record.view.id))
    )
      return false;
    if (
      !(await query.healthy(tenant, [
        run.target.connectionId,
        run.target.sourceConnectionId,
      ]))
    )
      return false;
    const current = await deps.read(
      tenant,
      run.target,
      run.operation === 'hold' && settings.exclusions.collections.length > 0,
      true,
    );
    if (run.operation === 'hold') {
      const metadata = current.protectionMetadata;
      if (
        !metadata?.complete ||
        !metadata.active ||
        settings.exclusions.skus.includes(
          metadata.sku ?? current.product?.sku ?? '',
        ) ||
        metadata.tags.some((tag) => settings.exclusions.tags.includes(tag)) ||
        metadata.collections.some((id) =>
          settings.exclusions.collections.includes(id),
        )
      )
        return false;
    }
    const age = +now() - Date.parse(current.source.observedAt);

    return (
      current.complete &&
      current.tracked &&
      current.inventoryPolicy === 'DENY' &&
      current.bundleParent === false &&
      age >= 0 &&
      age < 300000 &&
      current.revision === run.before.revision &&
      current.available === run.before.available &&
      (run.operation === 'release' || run.quantity < current.available!)
    );
  }

  const policies: PolicyService = createPolicies(
    context.database,
    context.refreshContext,
    policyAudit(audit),
    undefined,
    async (tenant, action, version) => {
      const run = await store.action(tenant, action.id);
      const record = run && (await store.get(tenant, run.incidentId));
      const decision = record?.view.decisionId
        ? await policies.decision(tenant, record.view.decisionId)
        : null;

      return decision?.policyVersion === version &&
        decision.approval?.outcome === 'approved'
        ? decision.approval
        : null;
    },
    async (tenant, action) => {
      const run = await store.action(tenant, action.id);
      if (!run || canonicalJson(run.action) !== canonicalJson(action))
        return false;
      const record = await store.get(tenant, run.incidentId);
      if (
        !record ||
        record.view.mode !== 'on' ||
        !(await released(tenant.tenantId))
      )
        return false;
      const decision = record.view.decisionId
        ? await policies.decision(tenant, record.view.decisionId)
        : null;
      if (decision?.approval?.outcome === 'rejected') return false;

      return admit(tenant, action);
    },
  );

  const effects: EffectRegistry = {
    async resolve(tenant, action) {
      if (action.capability !== 'inventory.available.protect') return null;
      const run = await store.action(tenant, action.target.id);
      if (!run || canonicalJson(run.action) !== canonicalJson(action))
        return null;
      const runtime = createCapabilityRuntime({
        record: async () => undefined,
        async resolve(fresh, connectionId) {
          const provider = await deps.provider(
            fresh,
            connectionId,
            run.holdId,
            () => permitted(fresh, run),
          );
          const original =
            provider.capabilities['inventory.available.reconcile'];
          const handler: CapabilityHandler<'inventory.available.protect'> = {
            descriptor: original.descriptor,
            parseInput: (input) => original.parseInput(input),
            parseOutput: (output) => original.parseOutput(output),
            run: (invocation, input) => original.run(invocation, input),
          };

          return {
            tenantId: fresh.tenantId,
            id: connectionId,
            provider: 'shopify',
            status: 'active',
            adapterVersion: 'shopify-stock-protection/1',
            mechanism: 'api',
            executor: { kind: 'connector', id: 'shopify-stock-protection/1' },
            capabilities: { 'inventory.available.protect': handler },
          };
        },
      });

      return runtime
        .effects({
          capability: 'inventory.available.protect',
          map: async () => ({
            inventoryItemId: run.before.inventoryItemId,
            locationId: run.before.locationId,
            expectedRevision: run.before.targetRevision,
            expectedAvailable: run.before.available!,
            available: run.quantity,
          }),
          checkPreconditions: () => permitted(tenant, run),
          verify: async () => {
            const current = await deps.read(tenant, run.target);
            const observedAt = new Date(
              Math.min(
                Date.parse(current.observedAt),
                Date.parse(current.source.observedAt),
              ),
            ).toISOString();
            const fresh =
              current.id !== run.before.id &&
              current.source.observationId !==
                run.before.source.observationId &&
              Date.parse(current.source.observedAt) >=
                Date.parse(run.before.observedAt);
            const verified =
              fresh &&
              current.complete &&
              current.tracked &&
              current.inventoryPolicy === 'DENY' &&
              current.protectionMetadata?.active === true &&
              current.available === run.quantity &&
              (run.operation !== 'release' ||
                (current.available === current.source.available &&
                  current.source.revision === run.before.source.revision)) &&
              current.inventoryItemId === run.before.inventoryItemId &&
              current.locationId === run.before.locationId &&
              current.writeAttribution?.referenceDocumentUri ===
                `luma://inventory-holds/${run.holdId}` &&
              current.writeAttribution.quantityMatches === true;

            return {
              outcome: verified ? 'passed' : 'inconclusive',
              observationRefs: [current.id, current.source.observationId],
              observedAt,
              evaluatorVersion: 'shopify-stock-protection/1',
            };
          },
        })
        .resolve(tenant, action);
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
    eligible: async (tenant, step) => {
      const run = await store.action(tenant, step.runId);

      return (
        !!run &&
        step.stepId === 'protect' &&
        step.actionHash === parseAction(run.action).hash &&
        (await permitted(tenant, run))
      );
    },
  });

  async function perform(tenant: TenantContext, run: ProtectionAction) {
    const artifact = await provisioning.activate(tenant, {
      id: 'shopify-stock-protection',
      version: '1',
      generation: { kind: 'manual', reference: 'stock-protection/1' },
      steps: {
        protect: {
          capability: 'inventory.available.protect',
          capabilityVersion: '0',
          targetKind: 'inventory_hold',
          minimumRisk: 'medium',
        },
      },
    });
    await provisioning.bind(tenant, {
      runId: run.id,
      stepId: 'protect',
      tenantId: tenant.tenantId,
      principalId: tenant.actor.id,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      artifactDigest: artifact.digest,
      subject: { kind: 'inventory_hold', id: run.holdId },
      eligibilityValidUntil: run.action.expiresAt,
      action: run.action,
    });
    const previous = await admission.get(tenant, run.id);
    const result =
      previous && 'record' in previous
        ? await admission.reconcile(tenant, run.id)
        : await admission.execute(tenant, { runId: run.id, stepId: 'protect' });
    if (result.state === 'not_executed') return 'preview' as const;
    if ('record' in result) {
      if (result.record.attempt.businessOutcome === 'satisfied')
        return 'verified' as const;
      if (result.record.attempt.dispatch === 'not_dispatched') {
        const failure = await readFailure(tenant, run.id);

        return failure?.effect === 'none' && failure.retry === 'after_delay'
          ? ('deferred' as const)
          : ('conflict' as const);
      }

      return 'unknown' as const;
    }

    return result.state === 'approval_required'
      ? ('approval_required' as const)
      : ('blocked' as const);
  }

  async function actionFor(
    tenant: TenantContext,
    record: ProtectionRecord,
    position: StockProtectionPosition,
    before: CorrectionSnapshot,
    operation: ProtectionAction['operation'],
    quantity: number,
    key: string,
  ) {
    const id = stableId(`${tenant.tenantId}:${position.id}:${key}`);
    const existing = await store.action(tenant, id);
    if (existing) return existing;
    const settings = await configuration(tenant, record);
    const expiresAt = new Date(+now() + 300000).toISOString();
    const action: ProposedAction = {
      schemaVersion: 1,
      id,
      tenantId: tenant.tenantId,
      capability: 'inventory.available.protect',
      capabilityVersion: '0',
      connectionId: record.view.connectionId,
      target: { kind: 'inventory_hold', id },
      parameters: {
        operation,
        available: quantity,
        expectedAvailable: before.available,
        policyRevision: settings.revision,
        sourceConnectionId: record.view.sourceConnectionId,
        incidentId: record.view.id,
        holdId: position.id,
        referenceDocumentUri: `luma://inventory-holds/${position.id}`,
      },
      preconditions: {
        evidenceRefs: [before.id, before.source.observationId],
        validUntil: expiresAt,
      },
      expectedPostcondition: { available: quantity },
      risk: 'medium',
      proposedBy: { kind: 'user', id: record.principalId },
      expiresAt,
    };

    return store.saveAction(tenant, {
      id,
      incidentId: record.view.id,
      holdId: position.id,
      key,
      operation,
      target: {
        positionId: position.positionId,
        connectionId: record.view.connectionId,
        sourceConnectionId: record.view.sourceConnectionId,
      },
      before,
      quantity,
      policyRevision: settings.revision,
      action,
    });
  }

  async function candidate(
    tenant: TenantContext,
    row: {
      positionId: string;
      skuId: string;
      native: boolean;
      unsettled: boolean;
    },
    settings: StockProtectionSettings,
  ): Promise<ProtectionCandidate> {
    try {
      const current = await deps.read(
        tenant,
        {
          positionId: row.positionId,
          connectionId: settings.connectionId,
          sourceConnectionId: settings.sourceConnectionId,
        },
        settings.exclusions.collections.length > 0,
      );
      const age = +now() - Date.parse(current.source.observedAt);

      return {
        ...row,
        sku: current.protectionMetadata?.sku ?? current.product?.sku ?? null,
        title: current.product?.title ?? null,
        available: current.available,
        authority: current.source.available,
        tracked: current.tracked,
        inventoryPolicy: current.inventoryPolicy ?? null,
        bundle: current.bundleParent ?? null,
        complete:
          current.complete &&
          current.protectionMetadata?.complete === true &&
          current.protectionMetadata.active &&
          age >= 0 &&
          age < 300000,
        tags: current.protectionMetadata?.tags ?? [],
        collections: current.protectionMetadata?.collections ?? [],
        sales24h: settings.includeSalesRate
          ? await query.sales(tenant, row.skuId, settings.connectionId)
          : null,
      };
    } catch {
      return {
        ...row,
        sku: null,
        title: null,
        available: null,
        authority: null,
        tracked: false,
        inventoryPolicy: null,
        bundle: null,
        complete: false,
        tags: [],
        collections: [],
        sales24h: null,
      };
    }
  }

  async function discover(tenant: TenantContext) {
    tenant = await scope(tenant);
    if (!(await released(tenant.tenantId))) return [];
    const settings = await consent.list(tenant);
    const previous = await store.heads(tenant);
    for (const stall of await query.stalls(tenant)) {
      if (stall.resolved || previous.some((r) => r.id === stall.id)) continue;
      const policy = settings.find(
        (s) =>
          s.connectionId === stall.connectionId &&
          s.sourceConnectionId === stall.sourceConnectionId &&
          s.mode !== 'off',
      );
      if (
        !policy ||
        !(await query.healthy(tenant, [
          policy.connectionId,
          policy.sourceConnectionId,
        ]))
      )
        continue;
      const rows = await query.candidates(tenant, policy.connectionId);
      const startedAt = now().toISOString();
      // Discovery persists only candidate identities. Each bounded activity rereads eligibility
      // before selecting a hold, so a large catalogue never blocks workflow discovery.
      const positions = rows
        .filter(
          (row) =>
            row.available === null ||
            row.available <= policy.riskThreshold ||
            policy.includeSalesRate,
        )
        .map((row): StockProtectionPosition => ({
          id: stableId(`${tenant.tenantId}:${stall.id}:${row.positionId}`),
          positionId: row.positionId,
          skuId: row.skuId,
          sku: null,
          title: null,
          status: row.native || row.unsettled ? 'not_protected' : 'pending',
          reason: row.native
            ? 'native_stock'
            : row.unsettled
              ? 'active_correction'
              : null,
          before: row.available,
          authority: null,
          held: null,
          current: row.available,
          startedAt: null,
          endedAt: null,
          unitMilliseconds: 0,
          exposedUnits: 0,
          actionId: null,
        }));
      await store.create(tenant, {
        view: {
          id: stall.id,
          connectionId: policy.connectionId,
          sourceConnectionId: policy.sourceConnectionId,
          label: stall.label,
          mode: policy.mode === 'preview' ? 'preview' : 'on',
          state: 'active',
          startedAt,
          endedAt: null,
          deadline: new Date(
            Date.parse(startedAt) + policy.maxDurationSeconds * 1000,
          ).toISOString(),
          releaseRequested: false,
          stopNew: false,
          decisionId: null,
          positions,
        },
        settings: policy,
        principalId:
          (await consent.principal(
            tenant,
            policy.connectionId,
            policy.sourceConnectionId,
          )) ?? tenant.actor.id,
        accountedAt: startedAt,
      });
    }

    return (await store.heads(tenant))
      .filter((r) => r.state !== 'released')
      .map((r) => ({ id: r.id, principalId: r.principalId }));
  }

  async function batchApproval(
    tenant: TenantContext,
    record: ProtectionRecord,
  ) {
    if (
      (
        await policies.approvalRequirement(tenant.tenantId, {
          minimumRisk: 'low',
        })
      ).mode !== 'every_action'
    )
      return true;
    const policyVersion = await policies.currentVersion(tenant.tenantId);
    let renewal: string | null = null;
    if (record.view.decisionId) {
      const decision = await policies.decision(tenant, record.view.decisionId);
      if (decision?.policyVersion === policyVersion) {
        if (decision.approval?.outcome === 'approved') {
          if (Date.parse(decision.approval.expiresAt) > +now()) {
            await store.update(tenant, record.view.id, (r) => {
              if (r.view.state === 'approval_required') r.view.state = 'active';
            });

            return true;
          }
          // First-response approvals are immutable. Renew the incident review rather than
          // requiring per-SKU reviews or reusing an expired approval for a later release.
          renewal = decision.approval.id;
        } else {
          if (!decision.approval && record.view.state !== 'approval_required')
            await store.update(tenant, record.view.id, (r) => {
              r.view.state = 'approval_required';
            });

          return false;
        }
      }
    }
    const action: ProposedAction = {
      schemaVersion: 1,
      id: stableId(
        `${record.view.id}:batch:${policyVersion}${renewal ? `:renew:${renewal}` : ''}`,
      ),
      tenantId: tenant.tenantId,
      capability: 'inventory.protection.batch',
      capabilityVersion: '0',
      connectionId: record.view.connectionId,
      target: { kind: 'stock_protection_incident', id: record.view.id },
      parameters: {
        positions: record.view.positions.filter(
          (p) => p.status === 'pending' || p.startedAt !== null,
        ).length,
        maxSkus: record.settings.maxSkus,
        maxUnitsPerSku: record.settings.maxUnitsPerSku,
      },
      preconditions: {
        evidenceRefs: [record.view.id],
        validUntil: new Date(+now() + 86400000).toISOString(),
      },
      expectedPostcondition: { protected: true },
      risk: 'medium',
      proposedBy: { kind: 'user', id: record.principalId },
      expiresAt: new Date(+now() + 86400000).toISOString(),
    };
    const decision = await policies.evaluate(
      tenant,
      action,
      parseAction(action).hash,
      {
        available: true,
        minimumRisk: 'medium',
        permission: operation.permission,
      },
    );
    await store.update(tenant, record.view.id, (r) => {
      r.view.decisionId = decision.id;
      r.view.state = 'approval_required';
    });

    return false;
  }

  async function tick(tenant: TenantContext, id: string) {
    tenant = await scope(tenant);
    let record = await store.get(tenant, id);
    if (!record || record.view.state === 'released') return { done: true };
    if (record.principalId !== tenant.actor.id)
      throw forbidden('Use the incident principal.');
    const settings = await configuration(tenant, record);
    const recovered = await query.recovered(tenant, id);
    const overdue = +now() >= Date.parse(record.view.deadline);
    record = await store.update(tenant, id, (r) => {
      const elapsed = Math.max(0, +now() - Date.parse(r.accountedAt));
      for (const position of r.view.positions)
        if (position.startedAt && !position.endedAt)
          position.unitMilliseconds +=
            Math.max(0, (position.before ?? 0) - (position.held ?? 0)) *
            elapsed;
      r.accountedAt = now().toISOString();
      if (recovered || (overdue && settings.durationAction === 'release'))
        r.view.releaseRequested = true;
      if (overdue && !r.view.releaseRequested) r.view.state = 'escalated';
    });
    if (overdue)
      await store.event(tenant, stableId(`${id}:escalated`), id, 'escalated');
    if (!(await released(tenant.tenantId))) return { done: false };
    const approved =
      record.view.mode === 'preview' || (await batchApproval(tenant, record));
    // One bounded batch gives API admission and other stores a turn between batches.
    const eligible = record.view.positions.filter(
      (p) =>
        (approved || p.startedAt !== null || p.actionId !== null) &&
        (active.has(p.status) ||
          (record!.view.mode === 'preview' && p.status === 'preview')),
    );
    const offset = (record.cursor ?? 0) % Math.max(1, eligible.length);
    const batch = [
      ...eligible.slice(offset),
      ...eligible.slice(0, offset),
    ].slice(0, 10);
    await store.update(tenant, id, (r) => {
      r.cursor = offset + batch.length;
    });
    for (const position of batch) {
      try {
        if (!approved && !position.startedAt && !position.actionId) continue;
        let run = position.actionId
          ? await store.action(tenant, position.actionId)
          : null;
        let deferredFrom: string | null = null;
        if (run) {
          const previous = await admission.get(tenant, run.id);
          if (
            previous &&
            'record' in previous &&
            previous.record.attempt.dispatch === 'not_dispatched'
          ) {
            const failure = await readFailure(tenant, run.id);
            if (failure?.effect === 'none' && failure.retry === 'after_delay')
              deferredFrom = run.id;
          }
          if (
            previous &&
            'record' in previous &&
            previous.record.attempt.businessOutcome !== 'satisfied' &&
            previous.record.attempt.dispatch !== 'not_dispatched'
          ) {
            const result = await perform(tenant, run);
            await settlePosition(tenant, id, position.id, run, result);
            continue;
          }
        }
        const current = await deps.read(tenant, {
          positionId: position.positionId,
          connectionId: record.view.connectionId,
          sourceConnectionId: record.view.sourceConnectionId,
        });
        const exclusion =
          current.bundleParent === true
            ? 'bundle'
            : !current.tracked
              ? 'untracked'
              : current.inventoryPolicy === 'CONTINUE'
                ? 'continue_selling'
                : current.itemActive === false ||
                    current.locationActive === false ||
                    current.protectionMetadata?.active === false
                  ? 'inactive'
                  : null;
        if (!position.startedAt && exclusion) {
          await store.update(tenant, id, (r) => {
            const p = r.view.positions.find((p) => p.id === position.id)!;
            if (p.startedAt || p.endedAt) return;
            p.status = 'not_protected';
            p.reason = exclusion;
          });
          continue;
        }
        if (
          current.available === null ||
          !current.complete ||
          (position.startedAt &&
            (!current.tracked ||
              current.inventoryPolicy !== 'DENY' ||
              current.bundleParent !== false ||
              current.protectionMetadata?.active !== true))
        )
          throw new Error('Inventory eligibility could not be confirmed');
        if (
          record.view.mode !== 'preview' &&
          position.startedAt &&
          position.held !== null
        ) {
          const outside = outsideHold(
            current.available,
            position.held,
            current.source.available,
          );
          if (outside) {
            await store.update(tenant, id, (r) => {
              const p = r.view.positions.find((p) => p.id === position.id)!;
              if (p.endedAt) return;
              p.current = current.available;
              p.authority = current.source.available;
              p.status = outside;
              p.endedAt = now().toISOString();
              p.actionId = null;
            });
            continue;
          }
        }
        await store.update(tenant, id, (r) => {
          const p = r.view.positions.find((p) => p.id === position.id)!;
          if (p.endedAt) return;
          p.current = current.available;
          p.authority = current.source.available;
          if (
            p.status === 'unknown' &&
            p.startedAt &&
            !p.actionId &&
            current.tracked &&
            current.inventoryPolicy === 'DENY' &&
            current.writeAttribution?.quantityMatches === true &&
            current.writeAttribution.referenceDocumentUri ===
              `luma://inventory-holds/${p.id}`
          ) {
            p.status = 'held';
            p.reason = null;
            if (
              r.view.state === 'unknown' &&
              !r.view.positions.some((other) => other.status === 'unknown')
            )
              r.view.state = 'active';
          }
          if (p.startedAt)
            p.exposedUnits = Math.max(
              p.exposedUnits,
              Math.max(0, p.before! - current.source.available),
            );
        });
        if (!approved) continue;
        if (record.view.mode === 'preview' && position.startedAt) {
          if (recovered)
            await store.update(tenant, id, (r) => {
              const p = r.view.positions.find((p) => p.id === position.id)!;
              p.status = 'released';
              p.endedAt = now().toISOString();
            });
          continue;
        }
        const operation =
          (record.view.releaseRequested ||
            record.releaseHoldIds?.includes(position.id)) &&
          position.startedAt
            ? 'release'
            : !position.startedAt
              ? 'hold'
              : 'tighten';
        if (
          operation === 'hold' &&
          (record.view.stopNew ||
            record.view.releaseRequested ||
            (settings.mode !== 'on' && record.view.mode !== 'preview') ||
            overdue)
        ) {
          await store.update(tenant, id, (r) => {
            const p = r.view.positions.find((p) => p.id === position.id)!;
            p.status = 'skipped';
            p.reason = 'stopped';
          });
          continue;
        }
        const quantity =
          operation === 'release'
            ? current.source.available
            : heldQuantity(
                current.available,
                current.source.available,
                settings,
              );
        if (
          operation === 'tighten' &&
          (current.source.available >= position.held! ||
            quantity >= position.held!)
        )
          continue;
        if (operation === 'hold') {
          const row = (
            await query.candidates(
              tenant,
              record.view.connectionId,
              position.positionId,
            )
          ).find((r) => r.positionId === position.positionId);
          if (!row) throw new Error('Position unavailable');
          const c = await candidate(tenant, row, settings);
          const reason = protectionExclusion(c, settings);
          if (reason) {
            await store.update(tenant, id, (r) => {
              const p = r.view.positions.find((p) => p.id === position.id)!;
              p.status = reason === 'incomplete' ? 'unknown' : 'not_protected';
              p.reason = reason;
            });
            continue;
          }
        }
        if (operation === 'hold') {
          record = await store.update(tenant, id, (r) => {
            const p = r.view.positions.find((p) => p.id === position.id)!;
            const selected = r.view.positions.filter(
              (other) => other.id !== p.id && other.held !== null,
            ).length;
            if (selected >= settings.maxSkus) {
              p.status = 'not_protected';
              p.reason = 'sku_cap';

              return;
            }
            p.held = quantity;
            p.before = current.available;
            p.authority = current.source.available;
            p.sku =
              current.protectionMetadata?.sku ?? current.product?.sku ?? null;
            p.title = current.product?.title ?? null;
            if (r.view.mode === 'preview') {
              p.status = 'preview';
              p.startedAt = now().toISOString();
            }
          });
          if (
            record.view.positions.find((p) => p.id === position.id)!.status ===
              'not_protected' ||
            record.view.mode === 'preview'
          )
            continue;
        }
        const key =
          operation === 'tighten'
            ? `tighten:${current.source.revision}:policy:${settings.revision}`
            : `${operation}:mode:${await query.writeRevision(tenant)}:policy:${settings.revision}${operation === 'release' ? `:${current.revision}` : ''}`;
        run = await actionFor(
          tenant,
          record,
          position,
          current,
          operation,
          quantity,
          `${deferredFrom ? `${key}:deferred:${deferredFrom}` : key}:approval:${record.view.decisionId ?? 'preauthorized'}`,
        );
        await store.update(tenant, id, (r) => {
          const p = r.view.positions.find((p) => p.id === position.id)!;
          p.actionId = run!.id;
          if (operation === 'hold') p.before = current.available;
        });
        let result = await perform(tenant, run);
        if (result === 'conflict' && operation === 'hold') {
          const fresh = await deps.read(tenant, run.target);
          const updated = heldQuantity(
            fresh.available!,
            fresh.source.available,
            settings,
          );
          run = await actionFor(
            tenant,
            record,
            position,
            fresh,
            operation,
            updated,
            'hold:retry',
          );
          await store.update(tenant, id, (r) => {
            const p = r.view.positions.find((p) => p.id === position.id)!;
            if (p.endedAt) return;
            p.actionId = run!.id;
            p.before = fresh.available;
            p.held = updated;
          });
          result = await perform(tenant, run);
        }
        await settlePosition(tenant, id, position.id, run, result);
      } catch {
        await store.update(tenant, id, (r) => {
          const p = r.view.positions.find((p) => p.id === position.id)!;
          if (p.endedAt || (!position.startedAt && p.startedAt)) return;
          p.status = 'unknown';
          p.reason = 'read_or_admission_unavailable';
          r.view.state = 'unknown';
        });
        await store.event(
          tenant,
          stableId(`${id}:partial_failure`),
          id,
          'partial_failure',
        );
      }
    }
    record = (await store.get(tenant, id))!;
    const done =
      !record.view.positions.some(
        (p) =>
          active.has(p.status) ||
          (record.view.mode === 'preview' && p.status === 'preview'),
      ) &&
      (record.view.releaseRequested || recovered);
    if (done) {
      await store.update(tenant, id, (r) => {
        r.view.state = 'released';
        r.view.endedAt = now().toISOString();
      });
      await store.event(tenant, stableId(`${id}:released`), id, 'released');
    }

    return {
      done,
      moreWork:
        approved &&
        !done &&
        record.view.positions.some(
          (p) =>
            p.status === 'pending' ||
            (p.status === 'unknown' && !p.startedAt) ||
            (record.view.releaseRequested &&
              (p.status === 'held' || p.status === 'tightened')),
        ),
    };
  }

  async function settlePosition(
    tenant: TenantContext,
    incidentId: string,
    holdId: string,
    run: ProtectionAction,
    result: Awaited<ReturnType<typeof perform>>,
  ) {
    await store.update(tenant, incidentId, (r) => {
      const p = r.view.positions.find((p) => p.id === holdId)!;
      if (p.endedAt) return;
      if (p.startedAt && run.operation === 'hold' && result !== 'verified')
        return;
      if (result === 'verified') {
        if (run.operation === 'hold') p.before = run.before.available;
        p.status =
          run.operation === 'release'
            ? 'released'
            : run.operation === 'tighten'
              ? 'tightened'
              : 'held';
        p.startedAt ??= now().toISOString();
        if (run.operation === 'release') p.endedAt = now().toISOString();
        p.held = run.quantity;
        p.current = run.quantity;
        p.authority = run.before.source.available;
        p.exposedUnits = Math.max(
          p.exposedUnits,
          Math.max(0, p.before! - run.before.source.available),
        );
        p.reason = null;
        p.actionId = null;
        if (
          r.view.state === 'unknown' &&
          !r.view.positions.some((other) => other.status === 'unknown')
        )
          r.view.state = 'active';
      } else if (result === 'deferred') {
        p.status = p.startedAt ? 'held' : 'pending';
        p.reason = 'deferred';
      } else if (result === 'preview') {
        p.status = p.startedAt ? 'held' : 'preview';
        p.reason = 'observe_only';
      } else if (result === 'conflict' || result === 'blocked') {
        p.status = run.operation === 'hold' ? 'skipped' : 'unknown';
        p.reason = result;
      } else if (result === 'approval_required')
        r.view.state = 'approval_required';
      else {
        p.status = 'unknown';
        p.reason = 'write_uncertain';
        r.view.state = 'unknown';
      }
    });
    if (['unknown', 'conflict', 'blocked', 'deferred'].includes(result))
      await store.event(
        tenant,
        stableId(`${incidentId}:partial_failure`),
        incidentId,
        'partial_failure',
      );
    if (result === 'verified' && run.operation === 'hold')
      await store.event(
        tenant,
        stableId(`${incidentId}:placed`),
        incidentId,
        'placed',
      );
  }

  return {
    discover,
    tick,
    async view(tenant: TenantContext, input?: unknown) {
      tenant = await scope(tenant);
      const filter = stockProtectionQuerySchema.parse(input ?? {});
      const authority = await context.sourceAuthority?.read(tenant);
      const sourceConnectionId = authority?.groups.find(
        (g) => g.group === 'inventory_stock',
      )?.connectionId;
      const pairs = await context.database.transaction(
        tenant.tenantId,
        async (tx) =>
          (
            await tx.query<{ connectionId: string; label: string }>(
              `SELECT id AS "connectionId",document->>'label' AS label FROM connector_installations WHERE tenant_id=$1 AND document->>'provider'='shopify' AND document->>'status'='active' ORDER BY id`,
              [tenant.tenantId],
            )
          ).rows,
      );

      const canReview =
        !tenant.supportView &&
        hasPermission(tenant, 'decisions.respond') &&
        (await context.hasPermission(tenant, operation));
      const independent = await policies.requiresIndependentApproval(
        tenant.tenantId,
      );

      return {
        enabled: await released(tenant.tenantId),
        canManage:
          hasPermission(tenant, 'workspace.approval_policy.manage') &&
          !tenant.supportView,
        settings: await consent.list(tenant),
        incidents: (await store.publicView(tenant, filter)).map((incident) => ({
          ...incident,
          canApprove:
            canReview &&
            incident.state === 'approval_required' &&
            (!independent || incident.requesterId !== tenant.actor.id),
        })),
        pairs: sourceConnectionId
          ? pairs.map((p) => ({ ...p, sourceConnectionId }))
          : [],
      };
    },
    async save(tenant: TenantContext, input: unknown) {
      tenant = await scope(tenant, true);
      if (!(await released(tenant.tenantId)))
        throw forbidden('Stock protection is not released for this workspace.');
      const parsed = z
        .object({
          settings: stockProtectionSettingsSchema,
          activeHolds: z.enum(['release', 'keep']).optional(),
        })
        .strict()
        .parse(input);
      const authority = await context.sourceAuthority?.read(tenant);
      if (
        authority?.groups.find((g) => g.group === 'inventory_stock')
          ?.connectionId !== parsed.settings.sourceConnectionId
      )
        throw conflict('The stock authority changed. Refresh settings.');
      await deps.authorize(tenant, parsed.settings.connectionId);
      const records = (await store.list(tenant)).filter(
        (r) =>
          r.view.connectionId === parsed.settings.connectionId &&
          r.view.sourceConnectionId === parsed.settings.sourceConnectionId &&
          r.view.state !== 'released',
      );
      if (
        parsed.settings.mode !== 'on' &&
        records.some((r) =>
          r.view.positions.some((p) => active.has(p.status)),
        ) &&
        !parsed.activeHolds
      )
        throw conflict(
          'Choose whether to release active holds or keep them until recovery.',
        );
      const saved = await consent.save(
        tenant,
        parsed.settings,
        tenant.actor.id,
      );
      for (const r of records)
        await store.update(tenant, r.view.id, (current) => {
          current.settings = saved;
          if (saved.mode === 'on') {
            const preview = current.view.mode === 'preview';
            current.view.mode = 'on';
            if (preview) {
              current.view.stopNew = false;
              current.view.deadline = new Date(
                +now() + saved.maxDurationSeconds * 1000,
              ).toISOString();
            }
            for (const position of current.view.positions)
              if (
                position.status === 'preview' &&
                (preview || !position.startedAt)
              ) {
                position.status = 'pending';
                position.actionId = null;
                position.startedAt = null;
                position.held = null;
                position.unitMilliseconds = 0;
                position.exposedUnits = 0;
              }
          }
          if (saved.mode !== 'on') {
            current.view.stopNew = true;
            current.view.releaseRequested ||= parsed.activeHolds === 'release';
          }
        });

      return saved;
    },
    async control(tenant: TenantContext, input: unknown) {
      tenant = await scope(tenant);
      const parsed = z
        .object({
          id: z.string().uuid(),
          action: z.enum(['release', 'extend', 'approve', 'reject']),
          holdId: z.string().uuid().optional(),
        })
        .strict()
        .parse(input);
      requireChangesAllowed(tenant);
      if (parsed.action === 'approve' || parsed.action === 'reject') {
        requirePermission(tenant, 'decisions.respond');
        await context.requirePermission(tenant, operation);
      } else requirePermission(tenant, 'workspace.approval_policy.manage');
      const record = await store.get(tenant, parsed.id);
      if (!record) throw notFound('Stock protection incident not found.');
      if (parsed.action === 'approve' || parsed.action === 'reject') {
        if (!record.view.decisionId)
          throw conflict('This incident is not awaiting approval.');
        const response = await policies.respond(
          tenant,
          record.view.decisionId,
          parsed.action === 'approve' ? 'approved' : 'rejected',
          new Date(+now() + 86400000).toISOString(),
        );
        if (response.outcome === 'approved')
          await store.update(tenant, parsed.id, (r) => {
            r.cursor = 0;
            if (r.view.state === 'approval_required') r.view.state = 'active';
          });
        if (response.outcome === 'rejected')
          await store.update(tenant, parsed.id, (r) => {
            r.view.stopNew = true;
            for (const p of r.view.positions) {
              if (!active.has(p.status)) continue;
              if (!p.startedAt && !p.actionId) p.status = 'skipped';
              p.reason = 'approval_rejected';
            }
            if (!r.view.positions.some((p) => active.has(p.status))) {
              r.view.state = 'released';
              r.view.endedAt = now().toISOString();
            } else r.view.state = 'active';
          });
      } else
        await store.update(tenant, parsed.id, (r) => {
          if (parsed.action === 'extend') {
            r.view.deadline = new Date(
              +now() + r.settings.maxDurationSeconds * 1000,
            ).toISOString();
            r.view.state = 'active';
          } else if (parsed.holdId) {
            if (!r.view.positions.some((p) => p.id === parsed.holdId))
              throw notFound('Hold not found.');
            r.releaseHoldIds = [
              ...new Set([...(r.releaseHoldIds ?? []), parsed.holdId]),
            ];
          } else {
            r.view.releaseRequested = true;
            r.view.stopNew = true;
          }
        });

      return (await store.get(tenant, parsed.id))!.view;
    },
  };
}
