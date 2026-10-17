import type { TenantContext } from '@luma/identity';
import {
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { conflict, forbidden, invalid, notFound } from '@luma/platform';

import type { ProposedAction } from '../domain/action.js';
import {
  type AutonomyAdmission,
  autonomyDecimal,
  type AutonomyHistory,
  autonomyMatches,
  type AutonomyScope,
  autonomyTrackRecord,
  evaluateAutonomy,
  hasLiveProof,
  previewAutonomy,
  type ScopedAutonomyPolicy,
  scopedResponsibility,
  type ScopedResponsibilityFacts,
} from '../domain/scoped-autonomy.js';

/** Minimal append-only audit evidence for a reviewed or automatic mode change. */
export interface AutonomyAudit {
  id: string;
  tenantId: string;
  policyId: string;
  revision: number;
  actorId: string;
  correlationId: string;
  at: string;
  previousMode: ScopedAutonomyPolicy['mode'] | null;
  mode: ScopedAutonomyPolicy['mode'];
  reason: string;
}

export interface AutonomyPolicyDraft {
  commandId: string;
  id: string;
  expectedRevision: number;
  name: string;
  scope: AutonomyScope;
  reason: string;
}

export interface AutonomyPolicyControl {
  commandId: string;
  expectedRevision: number;
  kind: 'pause' | 'resume' | 'revoke' | 'assist' | 'promote';
  connectionId?: string | undefined;
  reason: string;
}

/** Policy storage owns mutations, command idempotency, append-only revisions and audit outbox. */
export interface AutonomyRepository {
  list(tenantId: string): Promise<ScopedAutonomyPolicy[]>;
  history(tenantId: string, policyId: string): Promise<AutonomyHistory[]>;
  proposal(
    tenantId: string,
    proposalId: string,
  ): Promise<AutonomyHistory | null>;
  epoch(tenantId: string): Promise<number>;
  pending(tenantId: string): Promise<AutonomyAudit[]>;
  delivered(tenantId: string, id: string): Promise<void>;
  mutate(
    context: TenantContext,
    id: string,
    commandId: string,
    fingerprint: string,
    expectedRevision: number,
    reason: string,
    apply: (
      current: ScopedAutonomyPolicy | null,
      history: AutonomyHistory[],
    ) => ScopedAutonomyPolicy | Promise<ScopedAutonomyPolicy>,
  ): Promise<ScopedAutonomyPolicy>;
  recordProposal(tenantId: string, entry: AutonomyHistory): Promise<void>;
  recordReview(
    tenantId: string,
    proposalId: string,
    outcome: 'approved' | 'rejected',
  ): Promise<void>;
}

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

/** Rejects malformed or incoherent scope limits before storing a reviewed policy. */
function validateScope(scope: AutonomyScope) {
  const perAction = autonomyDecimal(scope.perActionQuantity),
    daily = autonomyDecimal(scope.dailyQuantity);
  if (
    scope.capability !== scopedResponsibility ||
    scope.unit !== 'follow_up' ||
    !scope.connectionIds.length ||
    perAction === null ||
    daily === null ||
    perAction <= 0n ||
    daily < perAction ||
    !Number.isInteger(scope.maxEvidenceAgeSeconds) ||
    scope.maxEvidenceAgeSeconds < 1 ||
    scope.maxEvidenceAgeSeconds > 300
  )
    throw invalid(
      'Use a bounded internal follow-up scope with valid quantity and freshness limits.',
    );
  for (const ids of [
    scope.connectionIds,
    scope.supplierIds,
    scope.locationIds,
    scope.recordIds,
  ])
    if (
      ids.length > 100 ||
      ids.some((id) => !uuid.test(id)) ||
      new Set(ids).size !== ids.length
    )
      throw invalid('Scope IDs must be unique workspace record identifiers.');
  if (scope.money) {
    const per = autonomyDecimal(scope.money.perAction),
      total = autonomyDecimal(scope.money.daily);
    if (
      !/^[A-Z]{3}$/.test(scope.money.currency) ||
      per === null ||
      total === null ||
      total < per
    )
      throw invalid('Use known monetary limits in one currency.');
  }
}

/** Creates bounded delegation commands and reads; promotion is explicit and based on live history. */
export function createScopedAutonomy(deps: {
  repository: AutonomyRepository;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  enabled(tenantId: string): Promise<boolean>;
  facts(
    context: TenantContext,
    action: ProposedAction,
  ): Promise<ScopedResponsibilityFacts | null>;
  environment?(
    context: TenantContext,
    connectionId: string,
  ): Promise<{
    environment: ScopedResponsibilityFacts['environment'];
    provenance: ScopedResponsibilityFacts['environmentProvenance'];
  }>;
  hash(value: unknown): string;
  appendAudit(event: AutonomyAudit): Promise<void>;
  now(): Date;
}) {
  async function fresh(context: TenantContext, write = false) {
    const current = await deps.refreshContext(context);
    requireTenant(current, context.tenantId);
    if (current.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');
    requirePermission(current, 'workspace.approval_policy.manage');
    if (write) requireChangesAllowed(current);

    return current;
  }

  async function flush(tenantId: string) {
    for (const event of await deps.repository.pending(tenantId)) {
      await deps.appendAudit(event);
      await deps.repository.delivered(tenantId, event.id);
    }
  }

  async function requireEnabled(tenantId: string) {
    if (!(await deps.enabled(tenantId)))
      throw forbidden('Scoped autonomy is not enabled for this workspace.');
  }

  const scopeHash = (scope: AutonomyScope) =>
    deps.hash({
      ...scope,
      connectionIds: [...scope.connectionIds].sort(),
      supplierIds: [...scope.supplierIds].sort(),
      locationIds: [...scope.locationIds].sort(),
      recordIds: [...scope.recordIds].sort(),
    });

  async function trackRecord(
    context: TenantContext,
    history: AutonomyHistory[],
    scopeHash: string,
  ) {
    const proofs = new Map<string, string>();
    for (const id of new Set(
      history.flatMap((entry) =>
        entry.facts.environmentProvenance
          ? [entry.facts.environmentProvenance.connectionId]
          : [],
      ),
    )) {
      const current = await deps.environment?.(context, id);
      if (current?.environment === 'live' && current.provenance)
        proofs.set(id, deps.hash(current.provenance));
    }

    return autonomyTrackRecord(
      history,
      scopeHash,
      (facts) =>
        !!facts.environmentProvenance &&
        proofs.get(facts.environmentProvenance.connectionId) ===
          deps.hash(facts.environmentProvenance),
    );
  }

  return {
    /** Reads current policies and separates live, synthetic and unknown earned-autonomy evidence. */
    async list(context: TenantContext) {
      const current = await fresh(context);
      const available = await deps.enabled(current.tenantId);
      await flush(current.tenantId);
      if (!available) return { available, policies: [] };
      const policies = await deps.repository.list(current.tenantId);

      return {
        available,
        policies: await Promise.all(
          policies.map(async (policy) => ({
            ...policy,
            trackRecord: await trackRecord(
              current,
              await deps.repository.history(current.tenantId, policy.id),
              policy.scopeHash,
            ),
          })),
        ),
      };
    },
    /** Saves a reviewed scope revision; a changed scope loses autonomous mode and its old approval binding. */
    async save(context: TenantContext, draft: AutonomyPolicyDraft) {
      const current = await fresh(context, true);
      await requireEnabled(current.tenantId);
      validateScope(draft.scope);
      if (
        !uuid.test(draft.id) ||
        !uuid.test(draft.commandId) ||
        !draft.name.trim() ||
        draft.name.length > 120 ||
        !draft.reason.trim() ||
        draft.reason.length > 1000
      )
        throw invalid(
          'Provide valid command and policy IDs, a name and a review reason.',
        );
      const fingerprint = deps.hash({ actor: current.actor.id, ...draft });
      const saved = await deps.repository.mutate(
        current,
        draft.id,
        draft.commandId,
        fingerprint,
        draft.expectedRevision,
        draft.reason,
        (previous) => {
          if (previous?.revoked)
            throw conflict('Revoked policies cannot be changed.');
          const hash = scopeHash(draft.scope);

          return {
            id: draft.id,
            tenantId: current.tenantId,
            revision: (previous?.revision ?? 0) + 1,
            name: draft.name.trim(),
            scope: draft.scope,
            scopeHash: hash,
            mode:
              previous?.scopeHash === hash
                ? previous.mode
                : previous
                  ? 'assisted'
                  : 'manual',
            paused: previous?.paused ?? false,
            pausedConnectionIds:
              previous?.pausedConnectionIds.filter((id) =>
                draft.scope.connectionIds.includes(id),
              ) ?? [],
            revoked: false,
            circuitReason: previous?.circuitReason ?? null,
            updatedAt: deps.now().toISOString(),
            updatedBy: current.actor.id,
          };
        },
      );
      await flush(current.tenantId);

      return saved;
    },
    /** Applies a revision-bound explicit pause, resumption, revocation or earned promotion. */
    async control(
      context: TenantContext,
      id: string,
      command: AutonomyPolicyControl,
    ) {
      const current = await fresh(context, true);
      await requireEnabled(current.tenantId);
      if (
        !uuid.test(id) ||
        !uuid.test(command.commandId) ||
        !command.reason.trim() ||
        command.reason.length > 1000
      )
        throw invalid('Provide valid IDs and a review reason.');
      const saved = await deps.repository.mutate(
        current,
        id,
        command.commandId,
        deps.hash({ actor: current.actor.id, id, ...command }),
        command.expectedRevision,
        command.reason,
        async (policy, history) => {
          if (!policy || policy.revoked) throw notFound('Policy not found.');
          if (
            command.connectionId &&
            !policy.scope.connectionIds.includes(command.connectionId)
          )
            throw invalid('This connection is outside the policy scope.');
          const next = {
            ...policy,
            revision: policy.revision + 1,
            updatedAt: deps.now().toISOString(),
            updatedBy: current.actor.id,
          };
          if (command.kind === 'revoke') {
            next.revoked = true;
            next.paused = true;
          }
          if (command.kind === 'pause') {
            if (command.connectionId)
              next.pausedConnectionIds = [
                ...new Set([...next.pausedConnectionIds, command.connectionId]),
              ];
            else next.paused = true;
          }
          if (command.kind === 'resume') {
            if (command.connectionId)
              next.pausedConnectionIds = next.pausedConnectionIds.filter(
                (value) => value !== command.connectionId,
              );
            else next.paused = false;
            next.circuitReason = null;
          }
          if (command.kind === 'assist' || command.kind === 'promote') {
            if (policy.paused || policy.pausedConnectionIds.length)
              throw conflict('Resume the policy before changing its mode.');
            if (
              command.kind === 'promote' &&
              !(await trackRecord(current, history, policy.scopeHash))
                .promotionEligible
            )
              throw conflict(
                'Autonomous mode needs at least 20 live reviewed and verified actions, at least 95% acceptance and verification, and no failed verification or uncertain dispatch in the evaluated history.',
              );
            next.mode = command.kind === 'promote' ? 'autonomous' : 'assisted';
          }

          return next;
        },
      );
      await flush(current.tenantId);

      return saved;
    },
    /** Historical preview uses only recorded owner facts and labels each environment separately. */
    async preview(context: TenantContext, id: string) {
      const current = await fresh(context);
      await requireEnabled(current.tenantId);
      const policy = (await deps.repository.list(current.tenantId)).find(
        (entry) => entry.id === id,
      );
      if (!policy) throw notFound('Policy not found.');
      const history = await deps.repository.history(current.tenantId, id);

      return {
        policyId: id,
        revision: policy.revision,
        asOf: deps.now().toISOString(),
        trackRecord: await trackRecord(current, history, policy.scopeHash),
        samples: previewAutonomy(policy, history),
      };
    },
    /** An immutable proposal's original source classification and binding must still match before review or dispatch. */
    async evidenceCurrent(
      context: TenantContext,
      proposalId: string,
      proof: {
        environment: ScopedResponsibilityFacts['environment'];
        provenance: ScopedResponsibilityFacts['environmentProvenance'];
      },
    ) {
      requireTenant(context, context.tenantId);
      const original = await deps.repository.proposal(
        context.tenantId,
        proposalId,
      );

      return (
        !original ||
        (original.facts.environment === proof.environment &&
          deps.hash(original.facts.environmentProvenance ?? null) ===
            deps.hash(proof.provenance ?? null))
      );
    },
    /** Internal release read; it controls availability and never grants action authority. */
    released: deps.enabled,
    /** Persisted enrollment remains governed when a deployment release is rolled back. */
    async managed(tenantId: string) {
      return (
        (await deps.enabled(tenantId)) ||
        (await deps.repository.epoch(tenantId)) > 0
      );
    },
    /** Internal admission hook. It never widens ordinary permissions, risk floors or approval requirements. */
    async evaluate(
      context: TenantContext,
      action: ProposedAction,
      minimumRisk: ProposedAction['risk'],
    ) {
      if (action.capability !== scopedResponsibility) return null;
      const released = await deps.enabled(context.tenantId);
      if (!released) {
        if (
          action.parameters.governed === true ||
          (await deps.repository.epoch(context.tenantId)) > 0
        )
          return {
            outcome: 'denied' as const,
            reason: 'paused' as const,
            admission: null,
          };

        return null;
      }
      const facts = await deps.facts(context, action);
      if (
        !facts ||
        facts.recordId !== action.target.id ||
        facts.connectionId !== action.connectionId ||
        action.target.kind !== 'purchase_order'
      )
        return {
          outcome: 'denied' as const,
          reason: 'out_of_scope' as const,
          admission: null,
        };
      const matches = (await deps.repository.list(context.tenantId)).filter(
        (policy) => !policy.revoked && autonomyMatches(policy, facts),
      );
      if (matches.length !== 1)
        return {
          outcome: 'denied' as const,
          reason: matches.length
            ? ('ambiguous_scope' as const)
            : ('out_of_scope' as const),
          admission: null,
        };
      const policy = matches[0]!;
      const at = deps.now().toISOString();
      const result = evaluateAutonomy(
        policy,
        facts,
        Date.parse(at),
        action.risk,
        minimumRisk,
      );
      if (
        policy.mode === 'autonomous' &&
        (!hasLiveProof(facts) ||
          !(
            await trackRecord(
              context,
              (
                await deps.repository.history(context.tenantId, policy.id)
              ).filter(
                (entry) =>
                  entry.facts.environmentProvenance?.sourceBinding ===
                    facts.environmentProvenance?.sourceBinding &&
                  entry.facts.environmentProvenance?.declarationRevision ===
                    facts.environmentProvenance?.declarationRevision,
              ),
              policy.scopeHash,
            )
          ).promotionEligible)
      ) {
        result.outcome = 'denied';
        result.reason = 'stale_evidence';
      }
      const admission: AutonomyAdmission = {
        policyId: policy.id,
        revision: policy.revision,
        scopeHash: policy.scopeHash,
        facts,
      };
      await deps.repository.recordProposal(context.tenantId, {
        policyId: policy.id,
        scopeHash: policy.scopeHash,
        proposalId: action.id,
        facts,
        actionRisk: action.risk,
        minimumRisk,
        review: 'not_reviewed',
        verification: 'not_checked',
        dispatch: 'not_dispatched',
        at,
      });

      return { ...result, admission };
    },
    /** Records an actual human response; model recommendations cannot add acceptance evidence. */
    recordReview: deps.repository.recordReview,
    /** A tenant-wide revision fence invalidates old decisions after any scoped control change. */
    epoch: deps.repository.epoch,
  };
}

export type ScopedAutonomy = ReturnType<typeof createScopedAutonomy>;
