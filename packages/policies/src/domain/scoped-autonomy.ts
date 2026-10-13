import type { ProposedAction } from './action.js';

/** The first reviewed responsibility only records an internal note; it never contacts a supplier. */
export const scopedResponsibility = 'procurement.follow-up.record';

type AutonomyMode = 'manual' | 'assisted' | 'autonomous';

/** Immutable scope and limits; changing them invalidates the scope's earned track record. */
export interface AutonomyScope {
  capability: typeof scopedResponsibility;
  connectionIds: string[];
  supplierIds: string[];
  locationIds: string[];
  recordIds: string[];
  unit: 'follow_up';
  perActionQuantity: string;
  dailyQuantity: string;
  money: { currency: string; perAction: string; daily: string } | null;
  maxEvidenceAgeSeconds: number;
}

/** A persisted, reviewed policy. Pause and revocation never undo an already dispatched effect. */
export interface ScopedAutonomyPolicy {
  id: string;
  tenantId: string;
  revision: number;
  name: string;
  scope: AutonomyScope;
  scopeHash: string;
  mode: AutonomyMode;
  paused: boolean;
  pausedConnectionIds: string[];
  revoked: boolean;
  circuitReason:
    | 'verification_failed'
    | 'uncertain_dispatch'
    | 'evidence_unavailable'
    | null;
  updatedAt: string;
  updatedBy: string;
}

/** Owner-read facts used by admission; the caller and model cannot supply these. */
export interface ScopedResponsibilityFacts {
  recordId: string;
  connectionId: string;
  supplierId: string | null;
  locationId: string | null;
  quantity: string;
  unit: 'follow_up';
  exposure: { amount: string; currency: string } | null;
  observedAt: string | null;
  complete: boolean;
  environment: 'live' | 'synthetic' | 'unknown';
  /** Retained positive proof at proposal time; existing unknown history is never reclassified. */
  environmentProvenance?: {
    basis:
      | 'reviewed_workspace_declaration'
      | 'simulation_manifest'
      | 'unclassified_source';
    connectionId: string;
    connectionVersion: number;
    credentialVersion: number;
    sourceBinding: string;
    declarationRevision: number | null;
    evidenceId: string | null;
  } | null;
}

/** A policy reservation bound to immutable intent and its trusted facts. */
export interface AutonomyAdmission {
  policyId: string;
  revision: number;
  scopeHash: string;
  facts: ScopedResponsibilityFacts;
}

/** One proposal's real history. Synthetic and unknown provenance never earn live authority. */
export interface AutonomyHistory {
  proposalId: string;
  policyId: string;
  scopeHash: string;
  facts: ScopedResponsibilityFacts;
  actionRisk: ProposedAction['risk'];
  minimumRisk: ProposedAction['risk'];
  review: 'accepted' | 'overridden' | 'not_reviewed';
  verification: 'passed' | 'failed' | 'unknown' | 'not_checked';
  dispatch: 'dispatched' | 'not_dispatched' | 'uncertain';
  at: string;
}

/** Fixed-scale non-negative quantities prevent rounding a concurrent budget past its limit. */
export function autonomyDecimal(value: string): bigint | null {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');

  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

const includes = (scope: readonly string[], value: string | null) =>
  !scope.length || (value !== null && scope.includes(value));

/** Tests owner identity against every scope dimension; missing restricted metadata does not match. */
export function autonomyMatches(
  policy: ScopedAutonomyPolicy,
  facts: ScopedResponsibilityFacts,
) {
  return (
    policy.scope.connectionIds.includes(facts.connectionId) &&
    includes(policy.scope.supplierIds, facts.supplierId) &&
    includes(policy.scope.locationIds, facts.locationId) &&
    includes(policy.scope.recordIds, facts.recordId)
  );
}

export type AutonomyBlock =
  | 'out_of_scope'
  | 'ambiguous_scope'
  | 'paused'
  | 'manual'
  | 'stale_evidence'
  | 'quantity_limit'
  | 'money_unknown'
  | 'money_limit'
  | 'risk_floor';

/** Applies bounded delegation without reducing capability risk floors or accepting model confidence. */
export function evaluateAutonomy(
  policy: ScopedAutonomyPolicy,
  facts: ScopedResponsibilityFacts,
  now: number,
  risk: ProposedAction['risk'],
  minimumRisk: ProposedAction['risk'],
  requireLiveProof = true,
): {
  outcome: 'allowed' | 'approval_required' | 'denied';
  reason: AutonomyBlock | null;
} {
  if (!autonomyMatches(policy, facts))
    return { outcome: 'denied', reason: 'out_of_scope' };
  if (
    policy.revoked ||
    policy.paused ||
    policy.pausedConnectionIds.includes(facts.connectionId)
  )
    return { outcome: 'denied', reason: 'paused' };
  if (policy.mode === 'manual') return { outcome: 'denied', reason: 'manual' };
  const observed =
    facts.observedAt === null ? NaN : Date.parse(facts.observedAt);
  if (
    !facts.complete ||
    !Number.isFinite(observed) ||
    observed > now ||
    now - observed > policy.scope.maxEvidenceAgeSeconds * 1000
  )
    return { outcome: 'denied', reason: 'stale_evidence' };
  const quantity = autonomyDecimal(facts.quantity),
    limit = autonomyDecimal(policy.scope.perActionQuantity);
  if (
    facts.unit !== policy.scope.unit ||
    quantity === null ||
    limit === null ||
    quantity <= 0n ||
    quantity > limit
  )
    return { outcome: 'denied', reason: 'quantity_limit' };
  if (policy.scope.money) {
    const exposure =
      facts.exposure === null ? null : autonomyDecimal(facts.exposure.amount);
    const moneyLimit = autonomyDecimal(policy.scope.money.perAction);
    if (
      exposure === null ||
      facts.exposure?.currency !== policy.scope.money.currency
    )
      return { outcome: 'denied', reason: 'money_unknown' };
    if (moneyLimit === null || exposure > moneyLimit)
      return { outcome: 'denied', reason: 'money_limit' };
  }
  if (requireLiveProof && policy.mode === 'autonomous' && !hasLiveProof(facts))
    return { outcome: 'denied', reason: 'stale_evidence' };
  if (risk !== 'low' || minimumRisk !== 'low')
    return { outcome: 'approval_required', reason: 'risk_floor' };

  return {
    outcome: policy.mode === 'assisted' ? 'approval_required' : 'allowed',
    reason: null,
  };
}

/** Requires an explicit retained reviewed declaration; a bare 'live' label cannot earn authority. */
export function hasLiveProof(facts: ScopedResponsibilityFacts) {
  const proof = facts.environmentProvenance;

  return (
    facts.environment === 'live' &&
    proof?.basis === 'reviewed_workspace_declaration' &&
    proof.declarationRevision !== null &&
    proof.declarationRevision > 0 &&
    !!proof.evidenceId &&
    !!proof.sourceBinding
  );
}

/** Live acceptance, override and independent verification rates for one unchanged scope. */
export function autonomyTrackRecord(
  history: readonly AutonomyHistory[],
  scopeHash: string,
  currentProof: (facts: ScopedResponsibilityFacts) => boolean = () => true,
) {
  const live = history.filter(
    (entry) =>
      entry.scopeHash === scopeHash &&
      hasLiveProof(entry.facts) &&
      currentProof(entry.facts),
  );
  const reviewed = live.filter((entry) => entry.review !== 'not_reviewed');
  const accepted = reviewed.filter(
    (entry) => entry.review === 'accepted',
  ).length;
  const checked = live.filter(
    (entry) =>
      entry.verification !== 'not_checked' &&
      entry.dispatch !== 'not_dispatched',
  );
  const passed = checked.filter(
    (entry) =>
      entry.verification === 'passed' && entry.dispatch === 'dispatched',
  ).length;
  const failures = live.filter(
    (entry) =>
      entry.verification === 'failed' ||
      entry.dispatch === 'uncertain' ||
      (entry.dispatch === 'dispatched' && entry.verification === 'unknown'),
  ).length;

  return {
    live: live.length,
    synthetic: history.filter(
      (entry) =>
        entry.scopeHash === scopeHash &&
        entry.facts.environment === 'synthetic',
    ).length,
    unknown: history.filter(
      (entry) =>
        entry.scopeHash === scopeHash && entry.facts.environment === 'unknown',
    ).length,
    reviewed: reviewed.length,
    verified: checked.length,
    acceptanceRate: reviewed.length ? accepted / reviewed.length : null,
    overrideRate: reviewed.length
      ? (reviewed.length - accepted) / reviewed.length
      : null,
    reviewerAgreementRate: reviewed.length ? accepted / reviewed.length : null,
    verificationPassRate: checked.length ? passed / checked.length : null,
    failures,
    promotionEligible:
      reviewed.length >= 20 &&
      checked.length >= 20 &&
      accepted / reviewed.length >= 0.95 &&
      passed / checked.length >= 0.95 &&
      failures === 0,
  };
}

/** Replays the bounded retained window chronologically; environments never share hypothetical budgets. */
export function previewAutonomy(
  policy: ScopedAutonomyPolicy,
  history: readonly AutonomyHistory[],
) {
  const usage = new Map<string, { quantity: bigint; exposure: bigint }>();
  const outcomes = new Map<string, ReturnType<typeof evaluateAutonomy>>();
  for (const entry of [...history].sort(
    (a, b) =>
      a.at.localeCompare(b.at) || a.proposalId.localeCompare(b.proposalId),
  )) {
    const result = evaluateAutonomy(
      policy,
      entry.facts,
      Date.parse(entry.at),
      entry.actionRisk,
      entry.minimumRisk,
      false,
    );
    if (result.outcome !== 'denied') {
      const key = `${entry.facts.environment}:${new Date(entry.at).toISOString().slice(0, 10)}`;
      const current = usage.get(key) ?? { quantity: 0n, exposure: 0n };
      const quantity = autonomyDecimal(entry.facts.quantity)!;
      const exposure = policy.scope.money
        ? autonomyDecimal(entry.facts.exposure!.amount)!
        : 0n;
      if (
        current.quantity + quantity >
        autonomyDecimal(policy.scope.dailyQuantity)!
      ) {
        result.outcome = 'denied';
        result.reason = 'quantity_limit';
      } else if (
        policy.scope.money &&
        current.exposure + exposure > autonomyDecimal(policy.scope.money.daily)!
      ) {
        result.outcome = 'denied';
        result.reason = 'money_limit';
      } else
        usage.set(key, {
          quantity: current.quantity + quantity,
          exposure: current.exposure + exposure,
        });
    }
    outcomes.set(entry.proposalId, result);
  }

  return history.map((entry) => ({
    proposalId: entry.proposalId,
    environment: entry.facts.environment,
    at: entry.at,
    ...outcomes.get(entry.proposalId)!,
  }));
}
