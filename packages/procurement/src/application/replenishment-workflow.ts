import type { AuditLog } from '@luma/audit';
import type { EffectRegistry } from '@luma/connections';
import type {
  ActionAdmission,
  AdmissionReader,
  BoundActionStep,
} from '@luma/execution';
import type { IdentityService, TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type { PolicyService } from '@luma/policies';
import type {
  PlaybookDependencies,
  ProcessRun,
  ProcessStepOutput,
  ProcessWorkflowVersion,
  ReadinessIssue,
  ReplenishmentBatchResult,
  ReplenishmentRunSummary,
  ReplenishmentWorkflow,
  TemplateRequirement,
  TemplateSource,
  VocabularyContribution,
  WorkflowCatalogStore,
  WorkflowReadiness,
  WorkflowTriggerRequest,
  WorkflowTriggerRun,
  WorkflowTriggerStore,
} from '@luma/workflows';
import {
  assessReadiness,
  createProcessActivities,
  describeApproval,
  draftFromVersion,
  presentProcessVersion,
  presentTriggerRun,
  summarizeOutcomes,
  templateReadiness,
} from '@luma/workflows';

import {
  replenishmentCommitments,
  stockUnusableReason,
} from '../domain/metrics.js';
import { planReplenishment } from '../domain/replenishment.js';
import {
  replenishmentOutcome,
  replenishmentStepCopy,
  ruleState,
  type StockReason,
  stockReasonMessage,
} from '../domain/replenishment-readiness.js';
import type { ProcurementService } from './procurement.js';
import type {
  ReplenishmentActivation,
  ReplenishmentStock,
  ReplenishmentStore,
} from './replenishment.js';

export interface ReplenishmentTransport {
  /** Starts the committed run with a stable Temporal workflow ID. */
  start(
    context: TenantContext,
    run: ProcessRun,
    version: ProcessWorkflowVersion,
  ): Promise<unknown>;
}

/** A purchase-order proposal that waits for a person's approval. */
export interface ReplenishmentDecision {
  runId: string;
  definitionId: string;
  positionId: string;
  connectionId: string;
  sku: string;
  supplier: string;
  quantity: number;
  unit: string | null;
  available: number | null;
  minimum: number;
  target: number;
  /** Quantities above this limit make the proposal high risk. */
  approvalQuantity: number;
  reference: string | null;
  /** When the stock read that justifies the proposal was taken. */
  checkedAt: string | null;
  requestedAt: string;
  requesterId: string;
  /** The proposal can't be approved after this; approval doesn't extend it. */
  expiresAt: string;
  risk: 'low' | 'medium' | 'high';
  /** Whether the reader may approve or reject it now, as the run review decides. */
  canRespond: boolean;
}

type ReplenishmentRuleInput = Parameters<ReplenishmentWorkflow['configure']>[1];

type WorkflowActivationView = Awaited<
  ReturnType<ReplenishmentWorkflow['configure']>
>;

/** Composes procurement reads, scoped grants, policy decisions and verified Temporal processes. */
export function createReplenishmentService(deps: {
  code?: Parameters<typeof createProcessActivities>[0]['code'];
  hash(value: unknown): string;
  id(value: string): string;
  version: ProcessWorkflowVersion;
  store: ReplenishmentStore;
  steps: {
    record(
      context: TenantContext,
      runId: string,
      output: ProcessStepOutput,
    ): Promise<void>;
    list(
      context: TenantContext,
      runIds: string[],
    ): Promise<Map<string, ProcessStepOutput[]>>;
  };
  catalog: Pick<WorkflowCatalogStore, 'publish'>;
  runs: WorkflowTriggerStore & {
    pending(context: TenantContext, id: string): Promise<WorkflowTriggerRun[]>;
  };
  triggers: {
    fire(
      context: TenantContext,
      id: string,
      input: WorkflowTriggerRequest,
    ): Promise<WorkflowTriggerRun>;
  };
  effects: EffectRegistry;
  audit: AuditLog;
  parseRule(input: unknown): ReplenishmentRuleInput;
  identity: Pick<IdentityService, 'refreshContext' | 'resolveWorkflowContext'>;
  procurement: ProcurementService;
  safety: {
    execution: ActionAdmission;
    policies: PolicyService;
    provisioning: PlaybookDependencies['provisioning'] &
      Pick<AdmissionReader, 'step'>;
  };
  transport?: ReplenishmentTransport;
  enabled: boolean;
}) {
  const { version, store, steps, catalog, runs, effects, audit, triggers } =
    deps;
  const definitionId = version.definition.id;
  const available = deps.enabled && !!deps.transport;

  async function authorize(context: TenantContext, write = false) {
    const fresh = await deps.identity.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, write ? 'procurement.manage' : 'procurement.read');
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

    return fresh;
  }

  function conflict(message: string): never {
    throw new IdentityError(409, 'CONFLICT', message);
  }

  function assertAvailable() {
    if (!available)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Replenishment execution is unavailable. Check the workflow worker connection.',
      );
  }

  const resolveContext = (run: ProcessRun) =>
    deps.identity.resolveWorkflowContext(run.actor.id, run.tenantId, run.id);

  async function activation(context: TenantContext, id: string) {
    const item = (await store.list(context)).find((r) => r.id === id);
    if (!item)
      throw new IdentityError(
        404,
        'NOT_FOUND',
        'Replenishment activation not found.',
      );

    return item;
  }

  async function stock(context: TenantContext, rule: ReplenishmentActivation) {
    const result = (await store.stocks(context)).find(
      (s) =>
        s.positionId === rule.positionId &&
        s.connectionId === rule.connectionId,
    );
    if (!result)
      conflict(
        'The configured stock position is unavailable. Refresh inventory before retrying.',
      );

    return result;
  }

  async function plan(
    context: TenantContext,
    rule: ReplenishmentActivation,
    inventory: ReplenishmentStock,
    excludeOrder?: string,
  ) {
    const orders = await deps.procurement.orders(context);
    const commitments = replenishmentCommitments(
      orders.items,
      rule.sku,
      excludeOrder,
    );

    return {
      ...planReplenishment(rule, inventory, commitments.length > 0, Date.now()),
      commitmentIds: commitments.map((o) => o.id),
    };
  }

  const view = (rule: ReplenishmentActivation): WorkflowActivationView => ({
    id: rule.id,
    version: version.version,
    versionDigest: rule.versionDigest,
    artifactDigest: rule.artifactDigest,
    policyVersion: rule.policyVersion,
    active: rule.active,
    grants: {
      principalIds: [rule.principalId],
      connectionIds: [rule.connectionId],
      targetIds: [rule.positionId],
    },
    reviewedBy: rule.principalId,
    reviewedAt: rule.reviewedAt,
  });

  async function recordAudit(
    context: TenantContext,
    rule: ReplenishmentActivation,
    revoked = false,
  ) {
    await audit.append({
      id: deps.id(`${rule.id}:${revoked}`),
      tenantId: context.tenantId,
      eventKey: `replenishment:${rule.id}:${revoked}`,
      eventType: revoked ? 'workflow.activation_revoked' : 'workflow.activated',
      schemaVersion: 1,
      occurredAt: revoked ? rule.revokedAt! : rule.reviewedAt,
      actor: { kind: 'user', id: revoked ? rule.revokedBy! : rule.principalId },
      correlationId: rule.id,
      proposalId: rule.id,
      actionHash: rule.artifactDigest,
      evidenceRefs: [rule.positionId],
      details: {
        definitionId,
        activationId: rule.id,
        sku: rule.sku,
        minimum: String(rule.minimum),
        target: String(rule.target),
      },
    });
  }

  async function storedRun(context: TenantContext, id: string) {
    const run = await runs.run(context, id);
    if (
      !run ||
      run.definitionId !== definitionId ||
      run.versionDigest !== version.digest
    )
      throw new IdentityError(404, 'NOT_FOUND', 'Replenishment run not found.');

    return run;
  }

  // Approval needs someone who can manage procurement other than the principal who started the
  // run, while the rule is active and the proposal's evidence is still valid.
  const respondable = (
    context: TenantContext,
    run: { actor: { id: string } },
    rule: ReplenishmentActivation,
    validUntil: string | undefined,
  ) =>
    rule.active &&
    hasPermission(context, 'procurement.manage') &&
    context.actor.id !== run.actor.id &&
    !!validUntil &&
    Date.parse(validUntil) > Date.now();

  const plural = (count: number, one: string, many = `${one}s`) =>
    `${count} ${count === 1 ? one : many}`;
  const action = version.steps.find((step) => step.kind === 'capability');
  const findStock = (
    stocks: ReplenishmentStock[],
    rule: Pick<ReplenishmentActivation, 'positionId' | 'connectionId'>,
  ) =>
    stocks.find(
      (s) =>
        s.positionId === rule.positionId &&
        s.connectionId === rule.connectionId,
    );

  /** Lists unexpired proposals waiting for approval; callers authorize first. */
  async function listPending(
    context: TenantContext,
  ): Promise<ReplenishmentDecision[]> {
    const existing = await runs.pending(context, definitionId);
    if (!existing.length) return [];
    const [evidence, rules] = await Promise.all([
      steps.list(
        context,
        existing.map((r) => r.id),
      ),
      store.list(context),
    ]);
    const items: ReplenishmentDecision[] = [];
    for (const run of existing) {
      const outputs = evidence.get(run.id) ?? [];
      if (presentTriggerRun(run, outputs).processState !== 'awaiting_decision')
        continue;
      const waiting = outputs.find(
        (step) => step.kind === 'capability' && step.state === 'waiting',
      );
      const rule = rules.find(
        (r) => r.id === String(run.context.inputs.activationId),
      );
      if (!waiting?.evidenceRefs[0] || !rule) continue;
      const [binding, decision] = await Promise.all([
        deps.safety.provisioning.step(context, run.id, 'create-order'),
        deps.safety.policies.decision(context, waiting.evidenceRefs[0]),
      ]);
      if (
        !binding ||
        decision?.outcome !== 'approval_required' ||
        decision.approval ||
        decision.proposalId !== binding.action.id ||
        Date.parse(binding.action.preconditions.validUntil) <= Date.now()
      )
        continue;
      const line = JSON.parse(String(binding.action.parameters.lines))[0];
      const inventory = outputs.find((step) => step.stepId === 'inventory');
      items.push({
        runId: run.id,
        definitionId,
        positionId: rule.positionId,
        connectionId: rule.connectionId,
        sku: rule.sku,
        supplier: rule.supplier,
        quantity: Number(line.quantity),
        unit: typeof line.unit === 'string' ? line.unit : null,
        available:
          typeof inventory?.values.available === 'number'
            ? inventory.values.available
            : null,
        minimum: rule.minimum,
        target: rule.target,
        approvalQuantity: rule.approvalQuantity,
        reference:
          typeof binding.action.parameters.reference === 'string'
            ? binding.action.parameters.reference
            : null,
        checkedAt: inventory?.observedAt ?? null,
        requestedAt: waiting.recordedAt,
        requesterId: run.actor.id,
        expiresAt: binding.action.preconditions.validUntil,
        risk: binding.action.risk,
        canRespond: respondable(
          context,
          run,
          rule,
          binding.action.preconditions.validUntil,
        ),
      });
    }

    return items;
  }

  /** Reads the 50 most recent runs with their state and verified order, newest first. */
  async function recentRuns(context: TenantContext) {
    const list = await runs.list(context, definitionId);
    const evidence = await steps.list(
      context,
      list.map((run) => run.id),
    );

    return list.map((run) => {
      const outputs = evidence.get(run.id) ?? [];
      const order = outputs.find((step) => step.kind === 'verification')?.values
        .purchaseOrderId;

      return {
        id: run.id,
        createdAt: run.createdAt,
        positionId:
          run.subject.kind === 'inventory_position' ? run.subject.id : null,
        state: presentTriggerRun(run, outputs).processState,
        purchaseOrderId: typeof order === 'string' ? order : null,
      };
    });
  }

  type RecentRun = Awaited<ReturnType<typeof recentRuns>>[number];

  const runSummary = (run: RecentRun): ReplenishmentRunSummary => ({
    runId: run.id,
    state: run.state ?? null,
    summary: replenishmentOutcome(run.state),
    at: run.createdAt,
    purchaseOrderId: run.purchaseOrderId,
  });

  const outcomes = (recent: RecentRun[]) =>
    summarizeOutcomes(
      recent.map((run) => ({
        id: run.id,
        createdAt: run.createdAt,
        state: run.state,
      })),
      replenishmentOutcome,
    );

  /** States who approves drafts under current policy; thresholds never remove approval. */
  async function approval(
    context: TenantContext,
  ): Promise<WorkflowReadiness['approval']> {
    const behavior = describeApproval(
      await deps.safety.policies.approvalRequirement(context.tenantId, {
        minimumRisk:
          action?.kind === 'capability' ? action.minimumRisk : 'medium',
      }),
      'purchase-order draft',
    );

    return {
      ...behavior,
      details: [
        ...behavior.details,
        'A rule’s high-risk quantity marks larger drafts as high risk. It never removes approval.',
      ],
    };
  }

  const workerIssue: ReadinessIssue = {
    code: 'worker_unavailable',
    severity: 'blocking',
    message:
      'The workflow worker isn’t connected, so Luma can’t check stock or create orders.',
    scope: null,
    repair: {
      label: 'Ask whoever runs Luma to start the workflow worker',
      destination: 'server',
    },
  };
  const supplierIssue: ReadinessIssue = {
    code: 'no_supplier',
    severity: 'blocking',
    message:
      'Add the supplier you reorder from before setting up a stock rule.',
    scope: null,
    repair: { label: 'Add a supplier', destination: 'suppliers' },
  };

  /** Groups unusable stock by reason. It blocks when no covered position has usable stock. */
  function stockIssues(
    active: ReplenishmentActivation[],
    stocks: ReplenishmentStock[],
    now: number,
  ): ReadinessIssue[] {
    const groups = new Map<StockReason, ReplenishmentActivation[]>();
    for (const rule of active) {
      const reason = stockUnusableReason(findStock(stocks, rule), now);
      if (reason) groups.set(reason, [...(groups.get(reason) ?? []), rule]);
    }
    const unusable = [...groups.values()].flat().length;

    return [...groups].map(([reason, affected]) => {
      const [first] = affected as [ReplenishmentActivation];
      const connections = new Set(affected.map((rule) => rule.connectionId));

      return {
        code: `stock_${reason}`,
        severity: unusable === active.length ? 'blocking' : 'degrading',
        message: stockReasonMessage(reason),
        scope:
          affected.length <= 3
            ? affected.map((rule) => rule.sku).join(', ')
            : `${affected
                .slice(0, 2)
                .map((rule) => rule.sku)
                .join(', ')} and ${affected.length - 2} more`,
        repair:
          reason === 'missing'
            ? {
                label: 'Check the inventory connection',
                destination: 'connections',
                ...(connections.size === 1
                  ? { recordId: first.connectionId }
                  : {}),
              }
            : affected.length === 1
              ? {
                  label: `Review stock for ${first.sku}`,
                  destination: 'inventory_position',
                  recordId: first.positionId,
                }
              : {
                  label: 'Review stock in Inventory',
                  destination: 'inventory',
                },
      };
    });
  }

  /** Combines worker, setup, stock, decision and run facts into workflow readiness. */
  async function readiness(
    context: TenantContext,
    facts: {
      rules: ReplenishmentActivation[];
      stocks: ReplenishmentStock[];
      suppliers: number;
      waiting: ReplenishmentDecision[];
      recent: RecentRun[];
    },
  ) {
    const now = Date.now();
    const active = facts.rules.filter((rule) => rule.active);
    const ready = active.filter(
      (rule) => !stockUnusableReason(findStock(facts.stocks, rule), now),
    ).length;
    const issues: ReadinessIssue[] = available ? [] : [workerIssue];
    if (!active.length) {
      if (!facts.suppliers) issues.push(supplierIssue);
      if (!facts.stocks.some((stock) => !stock.deleted))
        issues.push({
          code: 'no_stock',
          severity: 'blocking',
          message: 'No inventory source has reported stock positions yet.',
          scope: null,
          repair: {
            label: 'Connect an inventory source',
            destination: 'connections',
          },
        });
    }
    issues.push(...stockIssues(active, facts.stocks, now));
    const [single] = facts.waiting;

    return assessReadiness({
      enablement: active.length
        ? 'enabled'
        : facts.rules.length
          ? 'paused'
          : 'not_enabled',
      issues,
      coverage: {
        unit: 'stock position',
        covered: active.length,
        ready,
        explanation: active.length
          ? `${plural(active.length, 'stock position')} ${active.length === 1 ? 'has' : 'have'} an active rule. ${ready} with fresh stock.`
          : 'No stock position has an active rule. Stock risk for positions without a rule is unknown, not zero.',
      },
      approval: await approval(context),
      waiting: {
        count: facts.waiting.length,
        repair:
          facts.waiting.length === 1 && single
            ? {
                label: 'Review the waiting decision',
                destination: 'needs_you',
                recordId: `replenishment:${single.runId}`,
              }
            : facts.waiting.length
              ? { label: 'Open Needs you', destination: 'needs_you' }
              : null,
      },
      outcomes: outcomes(facts.recent),
      enable: {
        label: facts.rules.length ? 'Add a stock rule' : 'Set up stock rules',
        destination: 'workflow_rules',
      },
      idle: `Luma checks ${plural(active.length, 'stock position')} and proposes a purchase-order draft when stock falls below the minimum.`,
    });
  }

  const api: ReplenishmentWorkflow = {
    definitionId,
    async setup(context) {
      context = await authorize(context);
      const [positions, suppliers, rules, waiting, recent] = await Promise.all([
        store.stocks(context),
        deps.procurement.suppliers(context),
        store.list(context),
        listPending(context),
        recentRuns(context),
      ]);
      const now = Date.now();

      return {
        available,
        canManage: hasPermission(context, 'procurement.manage'),
        positions: positions.filter((s) => !s.deleted),
        suppliers: suppliers.items,
        rules: rules.map((rule) => {
          const latest = recent.find(
            (run) => run.positionId === rule.positionId,
          );

          return {
            ...rule,
            status: ruleState(
              rule.active,
              stockUnusableReason(findStock(positions, rule), now),
            ),
            waitingRunId:
              waiting.find((item) => item.positionId === rule.positionId)
                ?.runId ?? null,
            latestRun: latest ? runSummary(latest) : null,
          };
        }),
      };
    },
    async detail(context): ReturnType<ReplenishmentWorkflow['detail']> {
      context = await authorize(context);
      const [rules, stocks, suppliers, waiting, recent] = await Promise.all([
        store.list(context),
        store.stocks(context),
        deps.procurement.suppliers(context),
        listPending(context),
        recentRuns(context),
      ]);
      const active = rules.filter((r) => r.active);
      const presented = presentProcessVersion(version);
      const blockers = available
        ? []
        : [
            'Replenishment execution is unavailable. Connect the workflow worker to enable it.',
          ];

      return {
        presentation: 'procurement.replenishment',
        summary: {
          id: definitionId,
          name: version.definition.name,
          purpose: version.definition.intent,
          category: 'procurement',
          capability: 'procurement.purchase-order.create',
          systems: ['luma'],
          availableVersion: version.version,
          status: !available
            ? 'unavailable'
            : active.length
              ? 'active'
              : rules.length
                ? 'revoked'
                : 'inactive',
          blockers,
          activeVersions: active.length ? [version.version] : [],
          readiness: await readiness(context, {
            rules,
            stocks,
            suppliers: suppliers.items.length,
            waiting,
            recent,
          }),
        },
        versions: [
          {
            ...presented,
            steps: presented.steps.map((step) => ({
              ...step,
              ...replenishmentStepCopy[step.id],
            })),
            compatible: available,
            blockers,
            category: 'procurement',
            format: 'workflow/2',
            applicability: version.applicability,
            inputs: version.inputs,
            context: version.context,
            systems: ['luma'],
            approval:
              'Someone else who can approve changes reviews each purchase-order proposal. Quantity above the configured limit is high risk. Workspace policy may require approval below that limit too.',
          },
        ],
        activations: rules.map(view),
        connections: [],
        principalId: context.actor.id,
        canManage: hasPermission(context, 'procurement.manage'),
        policyVersion: await deps.safety.policies.currentVersion(
          context.tenantId,
        ),
        evaluationEvidence: 'unavailable',
      };
    },
    async configure(context, input: ReplenishmentRuleInput) {
      context = await authorize(context, true);
      assertAvailable();
      const request = deps.parseRule(input);
      if (request.reviewedDigest !== version.digest)
        conflict('The workflow version changed. Refresh before activating.');
      const prior = (await store.list(context)).find(
        (r) => r.id === request.id,
      );
      if (prior) {
        if (
          prior.principalId !== context.actor.id ||
          Object.entries(request).some(
            ([key, value]) =>
              key !== 'reviewedDigest' &&
              prior[key as keyof ReplenishmentActivation] !== value,
          )
        )
          conflict(
            'This activation ID was already used with a different rule.',
          );
        await recordAudit(context, prior);

        return view(prior);
      }
      const inventory = (await store.stocks(context)).find(
        (s) =>
          s.positionId === request.positionId &&
          s.connectionId === request.connectionId &&
          !s.deleted,
      );
      const supplier = await deps.procurement.supplier(
        context,
        request.supplierId,
      );
      if (!inventory || !supplier)
        conflict(
          'Choose an available stock position and supplier in this workspace.',
        );
      if (inventory.sku.length > 200 || inventory.unit.length > 40)
        conflict(
          'The inventory SKU or unit exceeds the purchase-order field length. Update its mapping first.',
        );
      await catalog.publish(context, version);
      const artifact = await deps.safety.provisioning.activate(context, {
        id: request.id,
        version: version.version,
        generation: { kind: 'manual', reference: version.digest },
        steps: {
          'create-order': {
            capability: 'procurement.purchase-order.create',
            capabilityVersion: '1',
            targetKind: 'purchase_order',
            minimumRisk: 'medium',
          },
        },
      });
      const rule = {
        id: request.id,
        positionId: request.positionId,
        connectionId: request.connectionId,
        supplierId: request.supplierId,
        minimum: request.minimum,
        target: request.target,
        approvalQuantity: request.approvalQuantity,
      };
      const saved = await store.save(context, {
        ...rule,
        principalId: context.actor.id,
        versionDigest: version.digest,
        artifactDigest: artifact.digest,
        policyVersion: await deps.safety.policies.currentVersion(
          context.tenantId,
        ),
        reviewedAt: new Date().toISOString(),
        sku: inventory.sku,
        supplier: supplier.name,
        active: true,
      });
      await recordAudit(context, saved);

      return view(saved);
    },
    async preview(context, input) {
      context = await authorize(context, true);
      const [stocks, rules, supplier, orders] = await Promise.all([
        store.stocks(context),
        store.list(context),
        deps.procurement.supplier(context, input.supplierId),
        deps.procurement.orders(context),
      ]);
      if (!supplier) conflict('Choose a supplier in this workspace.');
      const now = Date.now();

      return {
        approval: await approval(context),
        supplier: { id: supplier.id, name: supplier.name },
        items: input.items.map((item) => {
          const stock = findStock(stocks, item);
          const existing = rules.find(
            (rule) => rule.active && rule.positionId === item.positionId,
          );
          const base = {
            positionId: item.positionId,
            connectionId: item.connectionId,
            sku: stock?.sku ?? existing?.sku ?? null,
            unit: stock?.unit ?? null,
            available: stock?.available ?? null,
            observedAt: stock?.observedAt ?? null,
            existingRule: existing
              ? {
                  id: existing.id,
                  supplier: existing.supplier,
                  minimum: existing.minimum,
                  target: existing.target,
                }
              : null,
            belowMinimum: false,
            proposedQuantity: null,
            risk: null,
          };
          if (existing)
            return {
              ...base,
              outcome: 'covered' as const,
              message: `An active rule already covers this position. It stays unchanged; revoke it first to replace it.`,
            };
          if (!stock || stock.deleted)
            return {
              ...base,
              outcome: 'unavailable' as const,
              message: 'The source doesn’t list this stock position.',
            };
          if (stock.sku.length > 200 || stock.unit.length > 40)
            return {
              ...base,
              outcome: 'unavailable' as const,
              message:
                'The SKU or unit is too long for a purchase order. Update its mapping first.',
            };
          if (item.target <= item.minimum)
            return {
              ...base,
              outcome: 'invalid' as const,
              message: 'Target stock must be above the minimum.',
            };
          const plan = planReplenishment(
            item,
            stock,
            replenishmentCommitments(orders.items, stock.sku).length > 0,
            now,
          );

          return {
            ...base,
            outcome: 'ready' as const,
            belowMinimum: plan.belowMinimum,
            proposedQuantity: plan.eligible ? plan.quantity : null,
            risk: plan.eligible
              ? plan.approvalRequired
                ? ('high' as const)
                : ('medium' as const)
              : null,
            message: !plan.fresh
              ? 'Stock is older than five minutes. The rule activates, but Luma waits for a fresh read before proposing anything.'
              : !plan.belowMinimum
                ? 'Stock is at or above the minimum. Luma proposes a draft only after it falls below.'
                : plan.committed
                  ? 'Stock is below the minimum, but an existing draft or open order covers this SKU. No new draft would be proposed.'
                  : `Stock is below the minimum. The first check would propose ${plan.quantity} ${stock.unit} for approval.`,
          };
        }),
      };
    },
    async configureMany(context, items) {
      context = await authorize(context, true);
      assertAvailable();
      const results: ReplenishmentBatchResult[] = [];
      for (const item of items) {
        const result = (
          status: ReplenishmentBatchResult['status'],
          code: ReplenishmentBatchResult['code'],
          message: string,
          activation: ReplenishmentBatchResult['activation'] = null,
        ) =>
          results.push({
            id: item.id,
            positionId: item.positionId,
            status,
            code,
            message,
            activation,
          });
        // Another rule for the position is never replaced; a replay of this item still succeeds.
        const covering = (await store.list(context)).find(
          (rule) =>
            rule.active &&
            rule.positionId === item.positionId &&
            rule.id !== item.id,
        );
        if (covering) {
          result(
            'failed',
            'covered',
            'An active rule already covers this position. It was left unchanged.',
          );
          continue;
        }
        try {
          result(
            'activated',
            'activated',
            'Activated. Luma now checks this position.',
            await api.configure(context, item),
          );
        } catch (error) {
          if (
            error instanceof IdentityError &&
            (error.statusCode === 401 || error.statusCode === 403)
          )
            throw error;
          if (error instanceof IdentityError && error.statusCode < 500)
            result('failed', 'rejected', error.message);
          else
            result(
              'uncertain',
              'uncertain',
              'Luma couldn’t confirm this activation. Retry it unchanged; the same request never creates a second rule.',
            );
        }
      }

      return results;
    },
    async coverage(context, positionId) {
      context = await authorize(context);
      const [rules, stocks, suppliers, waiting, recent] = await Promise.all([
        store.list(context),
        store.stocks(context),
        deps.procurement.suppliers(context),
        listPending(context),
        recentRuns(context),
      ]);
      const mine = rules.filter((rule) => rule.positionId === positionId);
      const rule = mine.find((item) => item.active) ?? mine[0] ?? null;
      const stock = rule
        ? findStock(stocks, rule)
        : (stocks.find((s) => s.positionId === positionId && !s.deleted) ??
          stocks.find((s) => s.positionId === positionId));
      if (!rule && !stock)
        throw new IdentityError(404, 'NOT_FOUND', 'Stock position not found.');
      const active = rule?.active ? rule : null;
      const now = Date.now();
      const reason = active ? stockUnusableReason(stock, now) : null;
      const sku = rule?.sku ?? stock?.sku ?? 'this position';
      const unit = stock?.unit ?? 'units';
      const issues: ReadinessIssue[] = available ? [] : [workerIssue];
      if (active && reason)
        issues.push({
          code: `stock_${reason}`,
          severity: 'blocking',
          message: stockReasonMessage(reason),
          scope: sku,
          repair:
            reason === 'missing'
              ? {
                  label: 'Check the inventory connection',
                  destination: 'connections',
                  recordId: active.connectionId,
                }
              : {
                  label: `Review stock for ${sku}`,
                  destination: 'inventory_position',
                  recordId: positionId,
                },
        });
      if (!active && !suppliers.items.length) issues.push(supplierIssue);
      const pending = waiting.filter((item) => item.positionId === positionId);
      const history = recent.filter((run) => run.positionId === positionId);
      const [first] = pending;
      const [latest] = history;

      return {
        definitionId,
        name: version.definition.name,
        purpose: version.definition.intent,
        canManage: hasPermission(context, 'procurement.manage'),
        readiness: assessReadiness({
          enablement: active ? 'enabled' : rule ? 'paused' : 'not_enabled',
          issues,
          coverage: {
            unit: 'stock position',
            covered: active ? 1 : 0,
            ready: active && !reason ? 1 : 0,
            explanation: active
              ? `Luma checks ${sku} against a minimum of ${active.minimum} ${unit} and proposes enough to reach ${active.target}.`
              : 'No active rule covers this position, so Luma doesn’t watch its stock.',
          },
          approval: await approval(context),
          waiting: {
            count: pending.length,
            repair: first
              ? {
                  label: 'Review the waiting decision',
                  destination: 'needs_you',
                  recordId: `replenishment:${first.runId}`,
                }
              : null,
          },
          outcomes: outcomes(history),
          enable: {
            label: rule
              ? 'Set up a new rule for this position'
              : 'Set up replenishment for this position',
            destination: 'workflow_rules',
            recordId: positionId,
          },
          idle: active
            ? `Luma checks this position and proposes a draft when stock falls below ${active.minimum} ${unit}.`
            : 'Luma doesn’t watch this position.',
        }),
        rule: rule
          ? {
              id: rule.id,
              supplier: rule.supplier,
              minimum: rule.minimum,
              target: rule.target,
              approvalQuantity: rule.approvalQuantity,
              active: rule.active,
            }
          : null,
        stock: stock
          ? {
              sku: stock.sku,
              unit: stock.unit,
              available: stock.available,
              observedAt: stock.observedAt,
            }
          : null,
        latestRun: latest ? runSummary(latest) : null,
      };
    },
    async revoke(context, id, digest) {
      context = await authorize(context, true);
      const rule = await activation(context, id);
      if (rule.artifactDigest !== digest)
        conflict('The reviewed activation changed. Refresh before revoking.');
      const revoked = await store.revoke(context, id);
      await deps.safety.provisioning.revoke(context, id, version.version);
      await recordAudit(context, revoked, true);

      return view(revoked);
    },
    async start(context, input) {
      context = await authorize(context, true);
      assertAvailable();
      const rule = await activation(context, input.activationId);
      if (rule.principalId !== context.actor.id)
        conflict('Only the principal who activated this rule can start it.');
      // The request key is independent of changing stock so a lost start response can be recovered.
      const sourceId = input.id;
      const key = deps.hash([
        context.tenantId,
        definitionId,
        version.digest,
        { kind: 'inventory_position', id: rule.positionId },
        'condition',
        sourceId,
      ]);
      let run = await runs.find(context, key);
      if (run && run.context.inputs.activationId !== rule.id)
        conflict('This start ID is already bound to another activation.');
      if (!run) {
        if (!rule.active)
          conflict('This replenishment activation was revoked.');
        const inventory = await stock(context, rule);
        const current = await plan(context, rule, inventory);
        if (!current.fresh)
          conflict(
            'Inventory is older than five minutes or unavailable. Refresh the source before starting.',
          );
        if (!current.belowMinimum)
          conflict(
            'Stock is at or above the configured minimum. No replenishment is needed.',
          );
        const now = inventory.observedAt;
        run = await triggers.fire(context, definitionId, {
          version: version.version,
          reviewedDigest: version.digest,
          subject: { kind: 'inventory_position', id: rule.positionId },
          signal: { kind: 'condition', sourceId, occurredAt: now },
          context: {
            inputs: { activationId: rule.id },
            evidence: {
              kind: 'replenishment',
              facts: { belowMinimum: true },
              observations: [
                {
                  id: inventory.observationId,
                  source: 'inventory',
                  observedAt: inventory.observedAt,
                },
              ],
            },
            provenance: { reference: rule.id, capturedAt: now },
          },
        });
      }
      await deps.transport!.start(context, run, version);

      return {
        ...presentTriggerRun(
          run,
          (await steps.list(context, [run.id])).get(run.id),
        ),
        activationId: rule.id,
      };
    },
    async review(context, id) {
      context = await authorize(context);
      const run = await storedRun(context, id);
      const rule = await activation(
        context,
        String(run.context.inputs.activationId),
      );
      const binding = await deps.safety.provisioning.step(
        context,
        id,
        'create-order',
      );
      const outputs = (await steps.list(context, [id])).get(id) ?? [];
      const pending = outputs.find(
        (step) => step.kind === 'capability' && step.state === 'waiting',
      );
      const decision = pending?.evidenceRefs[0]
        ? await deps.safety.policies.decision(context, pending.evidenceRefs[0])
        : null;
      const waiting =
        decision?.outcome === 'approval_required' &&
        !decision.approval &&
        decision.proposalId === binding?.action.id;
      const state = presentTriggerRun(run, outputs).processState;
      const terminal =
        state && !['running', 'awaiting_decision', 'waiting'].includes(state);

      const inventory = outputs.find((step) => step.stepId === 'inventory');
      const verification = outputs.find((step) => step.kind === 'verification');
      const orders = await deps.procurement.orders(context);
      const order = orders.items.find(
        (item) =>
          item.id === binding?.action.target.id &&
          item.origin.workflowRunId === id,
      );

      return {
        runId: id,
        supplierId: rule.supplierId,
        stock: {
          available:
            typeof inventory?.values.available === 'number'
              ? inventory.values.available
              : null,
          unit:
            typeof inventory?.values.unit === 'string'
              ? inventory.values.unit
              : null,
          minimum: rule.minimum,
          target: rule.target,
          checkedAt: inventory?.observedAt ?? null,
        },
        decision: decision
          ? {
              id: decision.id,
              outcome: decision.approval?.outcome ?? decision.outcome,
            }
          : null,
        purchaseOrder: order
          ? { id: order.id, reference: order.reference, status: order.status }
          : null,
        verification: {
          state:
            verification?.state === 'completed'
              ? 'verified'
              : verification?.state === 'failed'
                ? 'failed'
                : verification?.state === 'inconclusive'
                  ? 'inconclusive'
                  : 'not_verified',
          recordedAt: verification?.recordedAt ?? null,
        },
        proposalId: binding?.action.id ?? null,
        decisionId: waiting ? decision.id : null,
        quantity: binding
          ? Number(
              JSON.parse(String(binding.action.parameters.lines))[0].quantity,
            )
          : null,
        sku: rule.sku,
        supplier: rule.supplier,
        state: terminal
          ? state
          : waiting && state === 'awaiting_decision'
            ? 'approval_required'
            : (state ?? 'starting'),
        canRespond:
          !!waiting &&
          state === 'awaiting_decision' &&
          !terminal &&
          respondable(
            context,
            run,
            rule,
            binding?.action.preconditions.validUntil,
          ),
      };
    },
    async decide(context, id, input) {
      context = await authorize(context, true);
      const review = await api.review(context, id);
      if (!review.canRespond || review.decisionId !== input.decisionId)
        conflict(
          'This proposal changed, expired, or needs a different approver. Refresh its review.',
        );
      await deps.safety.policies.respond(
        context,
        input.decisionId,
        input.outcome,
        new Date(Date.now() + 300_000).toISOString(),
      );

      // Durable process polling observes the committed policy decision even if the API disconnects.
      return api.review(context, id);
    },
  };

  async function eligible(context: TenantContext, step: BoundActionStep) {
    if (
      !step.subject ||
      step.subject.kind !== 'inventory_position' ||
      step.artifactVersion !== version.version
    )
      return false;
    const run = await runs.run(context, step.runId);
    if (
      !run ||
      run.definitionId !== definitionId ||
      run.context.inputs.activationId !== step.artifactId ||
      run.versionDigest !== version.digest ||
      run.subject.id !== step.subject.id ||
      run.actor.id !== step.principalId
    )
      return false;
    const rule = await activation(context, step.artifactId);
    if (
      !rule.active ||
      rule.principalId !== context.actor.id ||
      rule.artifactDigest !== step.artifactDigest ||
      rule.positionId !== run.subject.id
    )
      return false;
    const inventory = await stock(context, rule);
    const current = await plan(context, rule, inventory, step.action.target.id);
    const line = JSON.parse(String(step.action.parameters.lines))[0];

    return (
      current.eligible &&
      inventory.sku === rule.sku &&
      current.quantity === line.quantity &&
      line.sku === rule.sku &&
      inventory.unit === line.unit &&
      Date.parse(step.action.preconditions.validUntil) > Date.now() &&
      step.action.parameters.supplierId === rule.supplierId
    );
  }

  const activities = createProcessActivities({
    ...(deps.code ? { code: deps.code } : {}),
    resolveContext,
    loadRun: runs.run,
    loadVersion: async (context, id, v) => {
      const item = await runs.version(context, id, v);

      return item?.format === 'workflow/2' ? item : null;
    },
    admission: deps.safety.execution,
    async read(run, step) {
      const context = await resolveContext(run);
      const rule = await activation(
        context,
        String(run.context.inputs.activationId),
      );
      const inventory = await stock(context, rule);
      const current = await plan(context, rule, inventory);
      const now = new Date().toISOString();
      if (step.id === 'inventory')
        return {
          values: {
            fresh: current.fresh && rule.active,
            available: inventory.available ?? 0,
            sku: inventory.sku,
            unit: inventory.unit,
          },
          evidenceRefs: [inventory.observationId],
          observedAt: now,
        };
      if (step.id !== 'proposal')
        throw new Error('Unsupported replenishment read');
      const supplier = await deps.procurement.supplier(
        context,
        rule.supplierId,
      );

      return {
        values: {
          eligible: current.eligible && !!supplier && rule.active,
          committed: current.committed,
          quantity: current.quantity,
          approvalRequired: current.approvalRequired,
          supplier: supplier?.name ?? rule.supplier,
        },
        evidenceRefs: [
          inventory.observationId,
          rule.supplierId,
          ...current.commitmentIds,
        ],
        observedAt: now,
      };
    },
    decision: async () => ({ state: 'pending' }),
    async bindAction(context, run, published, step, outputs) {
      const previous = await deps.safety.provisioning.step(
        context,
        run.id,
        step.id,
      );
      if (previous) return { proposalId: previous.action.id };
      if (published.digest !== version.digest || step.id !== 'create-order')
        throw new Error('Unsupported replenishment action');
      const rule = await activation(
        context,
        String(run.context.inputs.activationId),
      );
      const inventory = outputs.find((o) => o.stepId === 'inventory');
      const proposal = outputs.find((o) => o.stepId === 'proposal');
      if (!inventory || !proposal || !proposal.values.eligible)
        throw new Error('Replenishment proposal is unavailable');
      if (!(await store.claim(context, rule.positionId, rule.sku, run.id)))
        throw new IdentityError(
          409,
          'CONFLICT',
          'Another replenishment run is already handling this stock position.',
        );
      const id = deps.id(`${run.id}:order`);
      const validUntil = new Date(
        Date.parse(run.context.evidence.observations[0]!.observedAt) + 300_000,
      ).toISOString();
      await deps.safety.provisioning.bind(context, {
        runId: run.id,
        stepId: step.id,
        tenantId: run.tenantId,
        principalId: run.actor.id,
        artifactId: rule.id,
        artifactVersion: version.version,
        artifactDigest: rule.artifactDigest,
        subject: run.subject,
        eligibilityValidUntil: validUntil,
        action: {
          schemaVersion: 1,
          id: deps.id(`${run.id}:proposal`),
          tenantId: run.tenantId,
          capability: step.capability,
          capabilityVersion: step.capabilityVersion,
          connectionId: run.tenantId,
          target: { kind: 'purchase_order', id },
          parameters: {
            supplierId: rule.supplierId,
            reference: `REP-${run.id.slice(0, 8).toUpperCase()}`,
            workflowRunId: run.id,
            actionId: deps.id(`${run.id}:proposal`),
            lines: JSON.stringify([
              {
                id: deps.id(`${run.id}:line`),
                sku: rule.sku,
                description: `Replenish ${rule.sku}`,
                quantity: proposal.values.quantity,
                unit: inventory.values.unit,
              },
            ]),
          },
          expectedPostcondition: { status: 'draft' },
          preconditions: {
            evidenceRefs: [...inventory.evidenceRefs, ...proposal.evidenceRefs],
            validUntil,
          },
          risk: proposal.values.approvalRequired ? 'high' : 'medium',
          proposedBy: { kind: 'user', id: run.actor.id },
          expiresAt: validUntil,
        },
      });

      return { proposalId: deps.id(`${run.id}:proposal`) };
    },
    async verify(run) {
      const context = await resolveContext(run);
      const binding = await deps.safety.provisioning.step(
        context,
        run.id,
        'create-order',
      );
      if (!binding) throw new Error('Replenishment action is missing');
      const adapter = await effects.resolve(context, binding.action);
      const result = await adapter?.verify(binding.action);

      return {
        state:
          result?.outcome === 'passed'
            ? 'verified'
            : result?.outcome === 'failed'
              ? 'failed'
              : 'inconclusive',
        values: {
          purchaseOrderId: binding.action.target.id,
          quantity: Number(
            JSON.parse(String(binding.action.parameters.lines))[0].quantity,
          ),
          status: result?.outcome === 'passed' ? 'draft' : 'unverified',
        },
        evidenceRefs: result?.observationRefs.length
          ? result.observationRefs
          : [binding.action.id],
      };
    },
    async record(context, runId, output) {
      await steps.record(context, runId, output);
      await audit.append({
        id: deps.id(`${runId}:${output.stepId}:${output.state}`),
        tenantId: context.tenantId,
        eventKey: `replenishment:${runId}:${output.stepId}:${output.state}`,
        eventType:
          output.kind === 'verification'
            ? 'workflow.verification'
            : 'workflow.step_recorded',
        schemaVersion: 1,
        occurredAt: output.recordedAt,
        actor: { kind: 'user', id: context.actor.id },
        correlationId: runId,
        proposalId: runId,
        actionHash: deps.hash(output),
        evidenceRefs: output.evidenceRefs,
        details: {
          definitionId,
          runId,
          stepId: output.stepId,
          state: output.state,
          ...(output.kind === 'verification'
            ? {
                verification:
                  output.state === 'completed' ? 'passed' : output.state,
              }
            : {}),
        },
      });
      if (
        output.kind === 'end' ||
        ['escalated', 'denied', 'ended', 'failed', 'inconclusive'].includes(
          output.state,
        )
      )
        await store.release(context, runId);
    },
  });

  const outsideBuiltIn =
    'Purchase-order steps run only in the built-in Replenish low stock workflow. Use that template to create orders.';
  const readLabels: Record<string, [string, string]> = {
    inventory: [
      'Current stock',
      'Fresh available quantity, SKU and unit for the configured stock position.',
    ],
    'procurement.replenishment': [
      'Replenishment proposal',
      'Whether an order is needed, its quantity and supplier, checked against open orders.',
    ],
  };
  const reads = version.steps.filter((step) => step.kind === 'read');

  /** Describes the reads, action and result check this adapter owns, derived from its version. */
  async function vocabulary(): Promise<VocabularyContribution> {
    const typeOf = (
      value: Extract<
        ProcessWorkflowVersion['steps'][number],
        { kind: 'capability' }
      >['parameters'][string],
    ) =>
      value.source === 'literal'
        ? value.value === null
          ? ('null' as const)
          : (typeof value.value as 'string' | 'number' | 'boolean')
        : value.source === 'step'
          ? reads.find((step) => step.id === value.stepId)?.fields[value.field]
          : (value.source === 'input'
              ? version.inputs
              : version.context.fields)[value.field];
    const types = (items: Record<string, Parameters<typeof typeOf>[0]>) =>
      Object.fromEntries(
        Object.entries(items).flatMap(([name, value]) => {
          const type = typeOf(value);

          return type ? [[name, type]] : [];
        }),
      );
    const unavailable = { executable: false, reason: outsideBuiltIn };

    return {
      subjects: [
        {
          kind: 'inventory_position',
          label: 'Stock position',
          description: 'A mapped SKU at one inventory location.',
          ...unavailable,
        },
        {
          kind: 'purchase_order',
          label: 'Purchase order',
          description: 'A purchase order recorded in Procurement.',
          ...unavailable,
        },
      ],
      reads: reads.map((step) => ({
        source: step.source,
        label: readLabels[step.source]?.[0] ?? step.source,
        description: readLabels[step.source]?.[1] ?? '',
        fields: step.fields,
        ...unavailable,
      })),
      capabilities: version.steps.flatMap((step) =>
        step.kind === 'capability'
          ? [
              {
                capability: step.capability,
                version: step.capabilityVersion,
                label: 'Create a purchase-order draft',
                description:
                  'Records a draft purchase order for the supplier. It is not sent to the supplier.',
                targetKind: step.targetKind,
                minimumRisk: step.minimumRisk,
                approval:
                  'Workspace policy decides whether someone else who can approve changes must approve each order.',
                parameters: types(step.parameters),
                postcondition: types(step.expectedPostcondition),
                evaluators: version.steps.flatMap((item) =>
                  item.kind === 'verification' && item.forStep === step.id
                    ? [item.evaluatorVersion]
                    : [],
                ),
                ...unavailable,
              },
            ]
          : [],
      ),
      evaluators: version.steps.flatMap((step) =>
        step.kind === 'verification'
          ? [
              {
                version: step.evaluatorVersion,
                label: 'Check the purchase-order draft',
                description:
                  'Reads the order independently to confirm ownership, draft status, supplier and lines.',
                fields: step.fields,
                ...unavailable,
              },
            ]
          : [],
      ),
    };
  }

  /** Offers replenishment in the template gallery with the setup it still needs here. */
  const template: TemplateSource = {
    id: definitionId,
    async template(context) {
      const [setup, detail] = await Promise.all([
        api.setup(context),
        api.detail(context),
      ]);
      const requirements: TemplateRequirement[] = [
        {
          label: 'Workflow worker connected',
          met: available,
          detail: available
            ? 'Replenishment runs on the workflow worker.'
            : 'The workflow worker isn’t running on this Luma server. Whoever runs the server needs to start it; Luma can’t check stock or create orders without it.',
          fix: null,
        },
        {
          label: 'A supplier',
          met: setup.suppliers.length > 0,
          detail: setup.suppliers.length
            ? `${setup.suppliers.length} supplier(s) in Procurement.`
            : 'Add the supplier you reorder from in Procurement.',
          fix: setup.suppliers.length
            ? null
            : { label: 'Add a supplier', destination: 'procurement' },
        },
        {
          label: 'Mapped stock positions',
          met: setup.positions.length > 0,
          detail: setup.positions.length
            ? `${setup.positions.length} stock position(s) with current stock.`
            : 'Connect an inventory source and let Luma read its stock.',
          fix: setup.positions.length
            ? null
            : { label: 'Open Connections', destination: 'connections' },
        },
      ];

      return {
        id: definitionId,
        name: version.definition.name,
        purpose: version.definition.intent,
        category: 'procurement',
        trigger: 'When available stock falls below the minimum you set',
        steps: [
          'Read current stock for the position you choose',
          'Stop when stock is stale or an order is already open',
          'Create a purchase-order draft for your supplier',
          'Ask someone else who can approve changes to approve it when policy requires',
          'Check the draft independently',
        ],
        success:
          'A purchase-order draft exists for your supplier and is independently verified. It is not sent to the supplier.',
        requirements,
        readiness: templateReadiness(requirements),
        status: detail.summary.status,
        configure: 'replenishment',
        installed: !!(await runs.version(
          context,
          definitionId,
          version.version,
        )),
        version: version.version,
        digest: version.digest,
      };
    },
    content: () => draftFromVersion(version),
    async install(context) {
      await catalog.publish(await authorize(context, true), version);
    },
  };

  return {
    api,
    activities,
    eligible,
    version,
    vocabulary,
    template,
    /**
     * Lists unexpired purchase-order proposals that wait for approval, from persisted run state
     * only. It reads no provider and starts nothing; approval still goes through `api.decide`.
     */
    async pending(context: TenantContext): Promise<ReplenishmentDecision[]> {
      return listPending(await authorize(context));
    },
    /** Recovers committed starts and evaluates active stock conditions with observation deduplication. */
    async tick(context: TenantContext) {
      context = await authorize(context, true);
      if (!available) return;
      const existing = await runs.pending(context, definitionId);
      const evidence = await steps.list(
        context,
        existing.map((r) => r.id),
      );
      for (const run of existing) {
        if (run.actor.id !== context.actor.id) continue;
        const state = presentTriggerRun(run, evidence.get(run.id)).processState;
        if (
          !state ||
          ['running', 'awaiting_decision', 'waiting'].includes(state)
        )
          await deps.transport!.start(context, run, version);
      }
      for (const rule of await store.list(context)) {
        if (!rule.active || rule.principalId !== context.actor.id) continue;
        const inventory = await stock(context, rule);
        const current = await plan(context, rule, inventory);
        if (current.fresh && current.belowMinimum)
          await api.start(context, {
            id: deps.id(`${rule.id}:${inventory.observationId}`),
            activationId: rule.id,
          });
      }
    },
  };
}
