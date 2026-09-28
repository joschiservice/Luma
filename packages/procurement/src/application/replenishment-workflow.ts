import type { AuditLog } from '@luma/audit';
import type { EffectRegistry } from '@luma/connections';
import type {
  ActionAdmission,
  AdmissionReader,
  BoundActionStep,
} from '@luma/execution';
import type { IdentityService, TenantContext } from '@luma/identity';
import { IdentityError, requireRole, requireTenant } from '@luma/identity';
import type { PolicyService } from '@luma/policies';
import type {
  PlaybookDependencies,
  ProcessRun,
  ProcessStepOutput,
  ProcessWorkflowVersion,
  ReplenishmentWorkflow,
  WorkflowCatalogStore,
  WorkflowTriggerRequest,
  WorkflowTriggerRun,
  WorkflowTriggerStore,
} from '@luma/workflows';
import {
  createProcessActivities,
  presentProcessVersion,
  presentTriggerRun,
} from '@luma/workflows';

import { replenishmentCommitments } from '../domain/metrics.js';
import { planReplenishment } from '../domain/replenishment.js';
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
    requireRole(
      fresh,
      write ? ['owner', 'admin'] : ['owner', 'admin', 'member'],
    );
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

  const api: ReplenishmentWorkflow = {
    definitionId,
    async setup(context) {
      context = await authorize(context);
      const [positions, suppliers, rules] = await Promise.all([
        store.stocks(context),
        deps.procurement.suppliers(context),
        store.list(context),
      ]);

      return {
        available,
        canManage: context.actor.role !== 'member',
        positions: positions.filter((s) => !s.deleted),
        suppliers: suppliers.items,
        rules,
      };
    },
    async detail(context): ReturnType<ReplenishmentWorkflow['detail']> {
      context = await authorize(context);
      const rules = await store.list(context);
      const active = rules.filter((r) => r.active);
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
        },
        versions: [
          {
            ...presentProcessVersion(version),
            compatible: available,
            blockers,
            category: 'procurement',
            format: 'workflow/2',
            applicability: version.applicability,
            inputs: version.inputs,
            context: version.context,
            systems: ['luma'],
            approval:
              'A different owner or admin reviews each purchase-order proposal. Quantity above the configured limit is high risk. Workspace policy may require approval below that limit too.',
          },
        ],
        activations: rules.map(view),
        connections: [],
        principalId: context.actor.id,
        canManage: context.actor.role !== 'member',
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
          rule.active &&
          context.actor.role !== 'member' &&
          context.actor.id !== run.actor.id &&
          Date.parse(binding!.action.preconditions.validUntil) > Date.now(),
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

  return {
    api,
    activities,
    eligible,
    version,
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
