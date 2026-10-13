import { randomUUID } from 'node:crypto';

import type { AppDecision, AppFactoryContext } from '@luma/app-host';
import { createAuditLog } from '@luma/audit/composition';
import {
  type CapabilityHandler,
  ConnectorError,
  type EffectRegistry,
  type InstallationService,
} from '@luma/connections';
import {
  createAdmission,
  createAdmissionStore,
  createExecution,
  parseAction,
} from '@luma/execution/composition';
import type { TenantContext } from '@luma/identity';
import { hasPermission, IdentityError, requireTenant } from '@luma/identity';
import { canonicalJson } from '@luma/platform';
import type { ProposedAction } from '@luma/policies';
import { createPolicies } from '@luma/policies/composition';
import { z } from 'zod';

import {
  lineSchema,
  previewSchema,
  reference,
  targetSchema,
  updatePermission,
} from './domain/updates.js';
import { dispatchUpdate } from './infrastructure/update-dispatch.js';
import { createUpdateProvider } from './infrastructure/update-provider.js';
import {
  createUpdateStore,
  type StoredUpdate,
  type UpdateRun,
} from './infrastructure/update-store.js';

export { updatePermission };

/** Governed downstream quantity updates, bound to authoritative source reads and a one-shot durable fence. */
export function createStarshipitUpdates(
  context: AppFactoryContext,
  installations: InstallationService,
) {
  const store = createUpdateStore(context.database);
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
  const enabled = async (tenantId: string) =>
    !!(await context.featureEnabled?.(tenantId, 'starshipit-fulfillment')) &&
    !!(await context.featureEnabled?.(tenantId, 'starshipit-actions'));

  async function authorize(tenant: TenantContext) {
    const fresh = await context.refreshContext(tenant);
    requireTenant(fresh, tenant.tenantId);
    if (fresh.actor.id !== tenant.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again.');
    await context.requirePermission(fresh, {
      app: 'starshipit',
      permission: updatePermission,
      scopes: ['orders.read', 'fulfillment.read'],
    });

    return fresh;
  }

  const { provider, read } = createUpdateProvider(
    context,
    installations,
    store,
  );
  const unavailableEvidence = Symbol('unavailable authoritative evidence');

  async function authoritative(
    tenant: TenantContext,
    target: { connectionId: string; orderId: string },
    lines: { lineItemId: string; quantity: number }[],
    refresh = true,
  ) {
    const authority = await context.sourceAuthority?.read(tenant);
    const owner = authority?.groups.find(
      (group) => group.group === 'order_lines',
    );
    if (
      !authority ||
      owner?.state !== 'resolved' ||
      !owner.connectionId ||
      owner.connectionId === target.connectionId
    )
      return null;
    let source = await context.sourceOrderLines?.(tenant, {
      connectionId: target.connectionId,
      orderId: target.orderId,
      sourceConnectionId: owner.connectionId,
    });
    if (source && refresh && context.refreshOrder) {
      await context.refreshOrder(tenant, source.orderId, 0);
      source = await context.sourceOrderLines?.(tenant, {
        connectionId: target.connectionId,
        orderId: target.orderId,
        sourceConnectionId: owner.connectionId,
      });
    }
    if (
      !source?.complete ||
      Date.now() - Date.parse(source.observedAt) > 60000 ||
      Date.parse(source.observedAt) > Date.now()
    )
      return unavailableEvidence;
    if (
      !lines.every(
        (line) =>
          source.lines.find((item) => item.externalId === line.lineItemId)
            ?.quantity === String(line.quantity),
      )
    )
      return null;

    const plans = await context.orderChangePlans?.(
      tenant,
      source.orderId,
      null,
    );
    if (
      !plans ||
      !lines.every((line) =>
        plans.plans.some(
          (plan) =>
            plan.safety.state === 'safe' &&
            plan.steps.some(
              (step) =>
                step.connectionId === target.connectionId &&
                step.capability === 'orders.quantity.update' &&
                (step.executable || step.blockedBy === 'observe_only') &&
                step.handoff?.orderExternalId === target.orderId &&
                step.handoff.lines.some(
                  (item) =>
                    item.externalId === line.lineItemId &&
                    item.quantity === String(line.quantity),
                ),
            ),
        ),
      )
    )
      return null;

    return {
      revision: authority.revision,
      connectionId: owner.connectionId,
      observationId: source.observationId,
      canonicalOrderId: source.orderId,
    };
  }

  async function eligibility(
    tenant: TenantContext,
    run: UpdateRun,
    refresh = true,
  ) {
    if (
      !(await enabled(tenant.tenantId)) ||
      Date.now() >= Date.parse(run.action.expiresAt)
    )
      return 'changed' as const;
    if (refresh) {
      const current = await read(tenant, run);
      if (
        (current.order.status ?? current.order.order_status)?.toLowerCase() !==
          'unshipped' ||
        current.revision !== run.revision
      )
        return 'changed' as const;
    }
    const selectedAuthority = await context.sourceAuthority?.read(tenant);
    if (
      selectedAuthority?.revision !== run.authority.revision ||
      selectedAuthority.groups.find((group) => group.group === 'order_lines')
        ?.connectionId !== run.authority.connectionId
    )
      return 'changed' as const;
    const authority = await authoritative(tenant, run, run.lines, refresh);
    if (authority === unavailableEvidence) return 'unavailable' as const;

    return authority?.revision === run.authority.revision &&
      authority.connectionId === run.authority.connectionId &&
      authority.canonicalOrderId === run.authority.canonicalOrderId
      ? ('current' as const)
      : ('changed' as const);
  }

  async function unchanged(tenant: TenantContext, run: UpdateRun) {
    return (await eligibility(tenant, run)) === 'current';
  }

  async function load(tenant: TenantContext, id: string) {
    const saved = await store.get(tenant, id);
    if (!saved)
      throw new IdentityError(404, 'NOT_FOUND', 'Order correction not found.');
    await provider(tenant, saved.document.connectionId);

    return saved;
  }

  const effects: EffectRegistry = {
    async resolve(tenant, intent) {
      if (
        intent.capability !== 'orders.quantity.update' ||
        intent.target.kind !== 'starshipit_order_update' ||
        intent.capabilityVersion !== '0'
      )
        return null;
      const saved = await store.get(tenant, intent.target.id);
      if (
        !saved ||
        canonicalJson(intent) !== canonicalJson(saved.document.action)
      )
        return null;
      const run = saved.document;

      return {
        capability: 'orders.quantity.update',
        version: '0',
        minimumRisk: 'medium',
        permission: updatePermission,
        mechanism: 'api',
        executor: { kind: 'connector', id: 'starshipit-update/1' },
        dispatchIdentity: `starshipit:${run.connectionId}:starshipit-update/1`,
        checkPreconditions: () => unchanged(tenant, run),
        async execute(_intent, idempotencyKey) {
          const client = await provider(tenant, run.connectionId, true);

          return dispatchUpdate(run, idempotencyKey, {
            unchanged: () => unchanged(tenant, run),
            read: () => read(tenant, run),
            send: (id) => store.send(tenant, id),
            update: (order) => client.update(order),
            accepted: async (id) => {
              const evidenceId = randomUUID();
              await store.record(
                tenant,
                evidenceId,
                run.connectionId,
                new Date().toISOString(),
                { kind: 'acceptance', operationId: id },
              );
              await store
                .hint(tenant, run.connectionId, id)
                .catch(() => undefined);

              return evidenceId;
            },
          });
        },
        async verify() {
          await store.close(tenant, run.id);
          const fresh = await read(tenant, run);
          const fence = await store.get(tenant, run.id);
          const matches = run.lines.every(
            (line) =>
              fresh.order.items.find((item) => item.item_id === line.lineItemId)
                ?.quantity === String(line.quantity),
          );
          const passed = !!fence?.sent_at && matches;
          if (passed || !fence?.sent_at) await store.settle(tenant, run.id);

          return {
            outcome: passed
              ? 'passed'
              : !fence?.sent_at
                ? 'failed'
                : 'inconclusive',
            observationRefs: [fresh.id],
            observedAt: fresh.observedAt,
            evaluatorVersion: 'starshipit-quantities/1',
          };
        },
      };
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
      const saved = await store.get(tenant, step.runId);

      return (
        !!saved &&
        step.stepId === 'update' &&
        step.principalId === saved.document.action.proposedBy.id &&
        step.actionHash === parseAction(saved.document.action).hash &&
        (await unchanged(tenant, saved.document))
      );
    },
  });

  async function bind(tenant: TenantContext, run: UpdateRun) {
    const artifact = await provisioning.activate(tenant, {
      id: 'starshipit-order-update',
      version: '1',
      generation: { kind: 'manual', reference: 'starshipit-update/1' },
      steps: {
        update: {
          capability: 'orders.quantity.update',
          capabilityVersion: '0',
          targetKind: 'starshipit_order_update',
          minimumRisk: 'medium',
        },
      },
    });
    await provisioning.bind(tenant, {
      runId: run.id,
      stepId: 'update',
      tenantId: tenant.tenantId,
      principalId: run.action.proposedBy.id,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      artifactDigest: artifact.digest,
      subject: { kind: 'order', id: run.authority.canonicalOrderId },
      eligibilityValidUntil: run.action.expiresAt,
      action: run.action,
    });
  }

  async function view(
    tenant: TenantContext,
    saved: StoredUpdate,
    reread = true,
  ) {
    const run = saved.document;
    const execution = await admission.get(tenant, run.id);
    const decision = saved.decision_id
      ? await policies.decision(tenant, saved.decision_id)
      : null;
    const record = execution && 'record' in execution ? execution.record : null;
    const observeOnly =
      (await admission.writeMode?.(tenant, run.connectionId)) ===
      'observe_only';
    const eligible =
      !record && !saved.closed && (await eligibility(tenant, run, reread));
    const current = eligible === 'current';
    const policyCurrent =
      decision?.policyVersion ===
      (await policies.currentVersion(tenant.tenantId));
    const approved =
      decision?.outcome === 'allowed' ||
      decision?.approval?.outcome === 'approved';
    const unavailable =
      eligible === 'unavailable' &&
      policyCurrent &&
      decision?.outcome !== 'denied' &&
      decision?.approval?.outcome !== 'rejected';
    // An unfinished or failed refresh withholds approval and dispatch, but a later
    // independent read can restore eligibility. Inspection must not close that review.
    if (
      !record &&
      (eligible === 'changed' ||
        !policyCurrent ||
        decision?.outcome === 'denied' ||
        decision?.approval?.outcome === 'rejected')
    )
      await store.closePreview(tenant, run.id);

    return {
      id: run.id,
      connectionId: run.connectionId,
      orderId: run.orderId,
      lines: run.lines,
      expiresAt: run.action.expiresAt,
      observeOnly,
      state:
        record?.attempt.businessOutcome === 'satisfied'
          ? 'verified'
          : execution?.state === 'not_executed'
            ? 'not_executed'
            : record
              ? 'uncertain'
              : unavailable
                ? 'unavailable'
                : !current ||
                    !policyCurrent ||
                    decision?.outcome === 'denied' ||
                    decision?.approval?.outcome === 'rejected'
                  ? 'denied'
                  : decision?.approval?.outcome === 'approved'
                    ? 'approved'
                    : decision?.outcome === 'approval_required'
                      ? 'approval_required'
                      : 'preview',
      canExecute:
        !record &&
        current &&
        policyCurrent &&
        approved &&
        tenant.actor.id === run.action.proposedBy.id &&
        !observeOnly,
      canApprove:
        !record &&
        current &&
        policyCurrent &&
        hasPermission(tenant, 'decisions.respond') &&
        decision?.outcome === 'approval_required' &&
        !decision.approval &&
        (decision.requireIndependentApproval === false ||
          tenant.actor.id !== run.action.proposedBy.id),
      canCheck: !!record || unavailable,
    };
  }

  return {
    /** Lists persisted approval and reconciliation work without contacting the provider. */
    async decisions(tenant: TenantContext): Promise<AppDecision[]> {
      const fresh = await context.refreshContext(tenant);
      requireTenant(fresh, tenant.tenantId);
      if (
        fresh.actor.id !== tenant.actor.id ||
        !(await context.hasPermission(fresh, {
          app: 'starshipit',
          permission: updatePermission,
        }))
      )
        return [];
      const decisions: AppDecision[] = [];
      for (const saved of await store.open(fresh)) {
        const status = await view(fresh, saved, false);
        if (status.state === 'denied' || status.state === 'verified') continue;
        const run = saved.document;
        decisions.push({
          id: `starshipit:order_update:${run.id}`,
          kind: 'order_edit',
          reason: status.canCheck
            ? 'recovery'
            : status.state === 'approval_required'
              ? 'approval'
              : 'run',
          domain: 'orders',
          title: 'Review shipping quantity correction',
          why: status.canCheck
            ? 'A fresh read must confirm the shipping quantities.'
            : 'A reviewed downstream correction needs a decision.',
          consequences: [
            {
              response: 'review',
              text: 'Review the exact mapped line quantities before sending.',
            },
          ],
          change: run.lines.map((line) => ({
            label: line.lineItemId,
            value: `${line.currentQuantity} → ${line.quantity}`,
          })),
          impact: { level: 'unknown', text: null },
          requestedAt: run.observedAt,
          deadline: run.action.expiresAt,
          requesterId: run.action.proposedBy.id,
          evidence: {
            observedAt: run.observedAt,
            validUntil: run.action.preconditions.validUntil,
          },
          response: status.canCheck
            ? 'check'
            : status.canApprove
              ? 'decide'
              : status.canExecute
                ? 'run'
                : 'awaiting_other',
          subject: { label: run.orderId, detail: 'Starshipit' },
          record: {
            kind: 'order',
            source: { connectionId: run.connectionId, externalId: run.orderId },
          },
          owner: {
            kind: 'app_order',
            connectionId: run.connectionId,
            orderId: run.orderId,
          },
          group: { key: 'starshipit:order_update', label: 'Starshipit' },
          observeOnly: status.observeOnly,
        });
      }

      return decisions;
    },
    /** An effect-only adapter for installed capability discovery; immutable runs own its inputs and every caller passes the same Action Admission. */
    handler(
      tenant: TenantContext,
      connectionId: string,
    ): CapabilityHandler<'orders.quantity.update'> {
      return {
        descriptor: {
          version: '0',
          minimumRisk: 'medium',
          permission: updatePermission,
          idempotency: 'none',
          retry: { maxAttempts: 1, initialDelayMs: 0 },
        },
        parseInput: (value) =>
          z
            .object({
              operationId: z.string().uuid(),
              orderId: z.string().regex(/^[1-9]\d{0,15}$/),
              expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
              lines: z
                .array(
                  lineSchema.extend({
                    currentQuantity: z.number().int().min(0).max(999999),
                  }),
                )
                .min(1)
                .max(500),
            })
            .strict()
            .parse(value),
        parseOutput: (value) =>
          z
            .object({
              status: z.literal('accepted'),
              evidenceRefs: z.array(z.string().uuid()).min(1),
              providerRequestId: z.string().nullable(),
            })
            .strict()
            .parse(value),
        async run(invocation, input) {
          if (
            invocation.tenant.tenantId !== tenant.tenantId ||
            invocation.connectionId !== connectionId ||
            invocation.provider !== 'starshipit' ||
            !invocation.idempotencyKey
          )
            throw new ConnectorError({
              code: 'invalid_input',
              effect: 'none',
              retry: 'never',
            });
          const saved = await load(tenant, input.operationId);
          const run = saved.document;
          if (
            run.connectionId !== connectionId ||
            run.orderId !== input.orderId ||
            run.revision !== input.expectedRevision ||
            canonicalJson(run.lines) !== canonicalJson(input.lines)
          )
            throw new ConnectorError({
              code: 'conflict',
              effect: 'none',
              retry: 'never',
            });
          const fresh = await authorize(invocation.tenant);
          if (fresh.actor.id !== run.action.proposedBy.id)
            throw new ConnectorError({
              code: 'permission_denied',
              effect: 'none',
              retry: 'never',
            });
          await bind(fresh, run);
          const result = await admission.execute(fresh, {
            runId: run.id,
            stepId: 'update',
          });
          const evidence =
            'record' in result
              ? result.record.attempt.effectEvidenceRefs
              : null;
          if (!evidence?.length)
            throw new ConnectorError({
              code: 'conflict',
              effect:
                'record' in result &&
                result.record.attempt.dispatch !== 'not_dispatched'
                  ? 'unknown'
                  : 'none',
              retry: 'never',
            });

          return {
            status: 'accepted',
            evidenceRefs: evidence,
            providerRequestId:
              'record' in result
                ? (result.record.attempt.providerRequestId ?? null)
                : null,
          };
        },
      };
    },
    async inspect(tenant: TenantContext, input: unknown) {
      tenant = await authorize(tenant);
      const target = targetSchema.parse(input);
      const current = await read(tenant, target);

      return {
        orderId: target.orderId,
        status: current.order.status ?? current.order.order_status,
        lines: current.order.items.map((line) => ({
          lineItemId: line.item_id,
          title: line.description,
          sku: line.sku,
          quantity: Number(line.quantity),
        })),
        updates: await Promise.all(
          (await store.recent(tenant, target.connectionId, target.orderId)).map(
            (saved) => view(tenant, saved),
          ),
        ),
        enabled: await enabled(tenant.tenantId),
      };
    },
    async preview(tenant: TenantContext, input: unknown) {
      tenant = await authorize(tenant);
      const request = previewSchema.parse(input);
      if (!(await enabled(tenant.tenantId)))
        throw new IdentityError(
          409,
          'CONFLICT',
          'Starshipit corrections are unavailable.',
        );
      const prior = await store.get(tenant, request.requestId);
      if (prior) {
        if (
          prior.document.connectionId !== request.connectionId ||
          prior.document.orderId !== request.orderId ||
          canonicalJson(
            prior.document.lines.map(({ lineItemId, quantity }) => ({
              lineItemId,
              quantity,
            })),
          ) !== canonicalJson(request.lines)
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'This request belongs to another correction.',
          );

        return view(tenant, prior);
      }
      const before = await read(tenant, request);
      const authority = await authoritative(tenant, request, request.lines);
      if (
        !authority ||
        authority === unavailableEvidence ||
        (before.order.status ?? before.order.order_status)?.toLowerCase() !==
          'unshipped'
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'A fresh mapped authoritative order and an unshipped Starshipit order are required.',
        );
      const lines = request.lines.map((change) => {
        const item = before.order.items.find(
          (line) => line.item_id === change.lineItemId,
        );
        if (
          !item ||
          !Number.isSafeInteger(Number(item.quantity)) ||
          Number(item.quantity) > 999999 ||
          item.quantity === String(change.quantity)
        )
          throw new IdentityError(
            422,
            'CONFLICT',
            'Select an existing line with a changed quantity.',
          );

        return { ...change, currentQuantity: Number(item.quantity) };
      });
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const action: ProposedAction = {
        schemaVersion: 1,
        id: request.requestId,
        tenantId: tenant.tenantId,
        capability: 'orders.quantity.update',
        capabilityVersion: '0',
        connectionId: request.connectionId,
        target: { kind: 'starshipit_order_update', id: request.requestId },
        parameters: {
          orderId: request.orderId,
          revision: before.revision,
          lines: canonicalJson(lines),
          authorityRevision: authority.revision,
          authorityConnection: authority.connectionId,
        },
        preconditions: {
          evidenceRefs: [before.id, authority.observationId],
          validUntil: expiresAt,
        },
        expectedPostcondition: { lineQuantities: canonicalJson(request.lines) },
        risk: 'medium',
        proposedBy: { kind: 'user', id: tenant.actor.id },
        expiresAt,
      };
      const run: UpdateRun = {
        id: request.requestId,
        tenantId: tenant.tenantId,
        connectionId: request.connectionId,
        orderId: request.orderId,
        revision: before.revision,
        observedAt: before.observedAt,
        lines,
        authority,
        action,
      };
      const saved = await store.save(tenant, run);
      await bind(tenant, run);
      const decision = await policies.evaluate(
        tenant,
        action,
        parseAction(action).hash,
        {
          available: await unchanged(tenant, run),
          minimumRisk: 'medium',
          permission: updatePermission,
        },
      );
      await store.decision(tenant, run.id, decision.id);

      return view(tenant, { ...saved, decision_id: decision.id });
    },
    async execute(tenant: TenantContext, input: unknown) {
      tenant = await authorize(tenant);
      const saved = await load(tenant, reference.parse(input).id);
      if (saved.document.action.proposedBy.id !== tenant.actor.id)
        throw new IdentityError(
          403,
          'FORBIDDEN',
          'Only the requester can send this correction.',
        );
      await bind(tenant, saved.document);
      const result = await admission.execute(tenant, {
        runId: saved.document.id,
        stepId: 'update',
      });
      if ('decision' in result)
        await store.decision(tenant, saved.document.id, result.decision.id);

      return view(tenant, (await store.get(tenant, saved.document.id))!);
    },
    async approve(tenant: TenantContext, input: unknown) {
      tenant = await authorize(tenant);
      const request = reference
        .extend({ outcome: z.enum(['approved', 'rejected']) })
        .parse(input);
      const saved = await load(tenant, request.id);
      if (!(await view(tenant, saved)).canApprove || !saved.decision_id)
        throw new IdentityError(
          409,
          'CONFLICT',
          'This correction cannot be approved by you.',
        );
      await policies.respond(
        tenant,
        saved.decision_id,
        request.outcome,
        saved.document.action.expiresAt,
      );

      return view(tenant, saved);
    },
    async check(tenant: TenantContext, input: unknown) {
      tenant = await authorize(tenant);
      const saved = await load(tenant, reference.parse(input).id);
      const previous = await admission.get(tenant, saved.document.id);
      if (previous && 'record' in previous)
        await admission.reconcile(tenant, saved.document.id);
      else if (Date.now() >= Date.parse(saved.document.action.expiresAt))
        await store.settle(tenant, saved.document.id);

      return view(tenant, (await store.get(tenant, saved.document.id))!);
    },
  };
}
