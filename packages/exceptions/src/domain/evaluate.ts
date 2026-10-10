import type { Configuration, Decision, EvaluationInput } from './facts.js';
import { decimalUnits } from './facts.js';

const result = (
  decision: 'clear' | 'defer' | 'reject',
  reason: string,
): Decision => ({ decision, severity: null, reason });

const detect = (severity: 'medium' | 'high', reason: string): Decision => ({
  decision: 'detect',
  severity,
  reason,
});

/**
 * Evaluates one exception class against its configured thresholds, returning detect, clear,
 * or defer with an evidence-based reason.
 */
export function evaluate(
  input: EvaluationInput,
  now: string,
  thresholds: Configuration['thresholds'],
): Decision {
  const parsed = input;
  const clock = Date.parse(now);
  const t = thresholds;
  const age = (time: string) => (clock - Date.parse(time)) / 1000;
  const freshness = (...times: string[]) =>
    times.some((time) => age(time) < 0)
      ? result('defer', 'future_evidence')
      : times.some((time) => age(time) > t.freshnessSeconds)
        ? result('defer', 'stale_evidence')
        : null;
  if (parsed.facts.tenantId !== parsed.facts.evidenceTenantId)
    return result('reject', 'tenant_mismatch');
  switch (parsed.exceptionClass) {
    case 'sync_failure': {
      const f = parsed.facts;
      // A provider that stops accepting Luma blocks the connection's streams; that loss is the
      // issue. A connection a person disconnected stays clear.
      if (f.accessLost) return detect('high', 'access_lost');
      if (!f.active) return result('clear', 'inactive_connection');
      if (f.status === 'success')
        return f.scanComplete
          ? result('clear', 'read_succeeded')
          : result('defer', 'incomplete_evidence');
      if (
        [
          'authentication',
          'permission_denied',
          'invalid_response',
          'export_unavailable',
          'unsupported_capability',
          'unsupported_version',
        ].includes(f.errorCode ?? '')
      )
        return detect('high', 'hard_read_failure');
      if (
        ['transient', 'timeout', 'rate_limited'].includes(f.errorCode ?? '')
      ) {
        if (age(f.firstFailureAt) < 0)
          return result('defer', 'future_evidence');

        return f.retryExhausted && age(f.firstFailureAt) >= t.syncFailureSeconds
          ? detect('medium', 'retry_window_exhausted')
          : result('clear', 'retry_window_open');
      }

      return result('defer', 'unclassified_error');
    }
    case 'stuck_fulfillment': {
      const f = parsed.facts;
      if (!f.mapped) return result('defer', 'unmapped_fulfillment');
      if (!f.complete) return result('defer', 'incomplete_evidence');
      const stale = freshness(f.observedAt);
      if (stale) return stale;
      if (f.status === 'unknown') return result('defer', 'unknown_status');
      if (['completed', 'shipped', 'delivered', 'cancelled'].includes(f.status))
        return result('clear', 'terminal_operation');
      if (f.quantity === null) return result('defer', 'unknown_quantity');
      if (decimalUnits(f.quantity) < 0n)
        return result('defer', 'invalid_quantity');
      if (f.unit === 'unknown') return result('defer', 'incomparable_units');
      if (decimalUnits(f.quantity) === 0n)
        return result('clear', 'no_remaining_work');
      if (f.status === 'failed') return detect('high', 'operation_failed');
      if (f.eligibility === 'exempt')
        return result('clear', 'explicit_exemption');
      if (f.eligibility === 'unknown')
        return result('defer', 'unknown_eligibility');
      if (f.lastProgressAt === null || age(f.lastProgressAt) < 0)
        return result('defer', 'unknown_progress');

      return age(f.lastProgressAt) >= t.stuckSeconds
        ? detect('medium', 'progress_timeout')
        : result('clear', 'progress_within_window');
    }
    case 'inventory_mismatch': {
      const f = parsed.facts;
      if (f.authorityState && f.authorityState !== 'resolved')
        return result('defer', 'inconclusive_authority');
      if (!f.mappedSku) return result('defer', 'unmapped_sku');
      if (!f.equivalentPool || f.connectionIds[0] === f.connectionIds[1])
        return result('defer', 'incomparable_pool');
      if (!f.complete) return result('defer', 'incomplete_evidence');
      if (!f.projectionCurrent) return result('defer', 'ambiguous_projection');
      if (f.leftAvailable === null || f.rightAvailable === null)
        return result('defer', 'unknown_quantity');
      if (
        f.leftUnit === 'unknown' ||
        f.rightUnit === 'unknown' ||
        f.leftUnit !== f.rightUnit
      )
        return result('defer', 'incomparable_units');
      if (
        f.leftBasis !== 'provider_reported' ||
        f.rightBasis !== 'provider_reported'
      )
        return result('defer', 'incomparable_basis');
      const stale = freshness(f.leftObservedAt, f.rightObservedAt);
      if (stale) return stale;
      if (
        Math.abs(age(f.leftObservedAt) - age(f.rightObservedAt)) >
        t.pairSkewSeconds
      )
        return result('defer', 'observation_skew');
      const difference =
        decimalUnits(f.leftAvailable) - decimalUnits(f.rightAvailable);
      if (
        (difference < 0n ? -difference : difference) <=
        decimalUnits(f.tolerance)
      )
        return result('clear', 'within_tolerance');
      if (
        f.authority !== null &&
        f.authority !== f.sellingSource &&
        (f.sellingSource === 'left' ? difference > 0n : difference < 0n)
      )
        return detect('high', 'oversell_risk');

      return detect('medium', 'quantity_mismatch');
    }
    case 'workflow_failure': {
      const f = parsed.facts;
      if (!f.durable) return result('defer', 'missing_durable_evidence');
      if (f.effect === 'unknown')
        return detect('high', 'reconciliation_required');
      if (f.status === 'cancelled')
        return result('clear', 'intentional_cancellation');
      if (['running', 'succeeded'].includes(f.status))
        return result('clear', 'healthy_workflow');
      if (['failed', 'timed_out'].includes(f.status) && f.retryExhausted)
        return detect('high', 'terminal_failure');
      if (f.status === 'interrupted')
        return result('defer', 'missing_durable_decision');

      return result('clear', 'retry_pending');
    }
  }
}

/**
 * Returns the rule, subject, and scope used to identify an exception independently of
 * changing evidence.
 */
export function identity(input: EvaluationInput) {
  switch (input.exceptionClass) {
    case 'sync_failure':
      return {
        ruleIdentity: 'connection-read',
        subjectKind: 'connection',
        subjectId: input.facts.connectionId,
        scope: [input.facts.capability],
      };
    case 'stuck_fulfillment':
      return {
        ruleIdentity: 'fulfillment-progress',
        subjectKind: 'fulfillment',
        subjectId: input.facts.subjectId,
        scope: [input.facts.connectionId],
      };
    case 'inventory_mismatch':
      return {
        ruleIdentity: 'available-stock',
        subjectKind: 'sku',
        subjectId: input.facts.subjectId,
        scope: [
          input.facts.canonicalLocationId,
          ...[...input.facts.connectionIds].sort(),
        ],
      };
    case 'workflow_failure':
      return {
        ruleIdentity: 'workflow-step',
        subjectKind: 'workflow_run',
        subjectId: input.facts.runId,
        scope: [input.facts.stepKey],
      };
  }
}

/**
 * Returns stable fingerprint input for an exception; the caller supplies hashing and tenant
 * scoping.
 */
export function fingerprintMaterial(input: EvaluationInput): string {
  const key = identity(input);

  return JSON.stringify([
    'v0',
    input.exceptionClass,
    key.ruleIdentity,
    key.subjectKind,
    key.subjectId,
    key.scope,
  ]);
}
