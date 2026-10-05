import type { TransportFault } from './chaos.js';

/** Manual fault kinds: transport failures plus provider answers a profile does not produce. */
export const faultKinds = [
  'unavailable',
  'rate-limit',
  'server-error',
  'timeout',
  'reset',
  'malformed',
  'schema-drift',
  'unauthorized',
  'response-loss',
] as const satisfies readonly (TransportFault | string)[];

export type FaultKind = (typeof faultKinds)[number];

/** A precise, manually armed fault for reproducing one failure. */
export interface FaultRule {
  id: string;
  instance: string;
  /** Operation name, or `*` for every operation. */
  operation: string;
  resource?: string | undefined;
  kind: FaultKind;
  /** The first matching request that triggers the rule; earlier matches pass. */
  occurrence: number;
  /** How many triggers remain after the first. */
  remaining: number;
  matches: number;
  /** Simulation time after which the rule no longer applies. */
  expiresAt?: number | undefined;
  status: 'armed' | 'triggered' | 'expired' | 'disabled';
}

/** Response loss happens after a write commits; every other manual fault replaces the response. */
export const faultPhase = (kind: FaultKind) =>
  kind === 'response-loss' ? 'after-commit' : 'before';

/**
 * Applies one request to the rules in creation order and returns the first rule that fires.
 * Mutates match counts and status; the caller persists rules with the request's other effects.
 */
export function matchFault(
  rules: FaultRule[],
  target: {
    instance: string;
    operation: string;
    resource?: string | undefined;
    phase: 'before' | 'after-commit';
  },
  now: number,
) {
  for (const rule of rules) {
    if (rule.status !== 'armed') continue;
    if (rule.expiresAt !== undefined && rule.expiresAt <= now) {
      rule.status = 'expired';
      continue;
    }
    if (
      rule.instance !== target.instance ||
      (rule.operation !== '*' && rule.operation !== target.operation) ||
      faultPhase(rule.kind) !== target.phase ||
      (rule.resource !== undefined && rule.resource !== target.resource)
    )
      continue;
    if (++rule.matches < rule.occurrence) continue;
    if (--rule.remaining <= 0) rule.status = 'triggered';

    return rule;
  }

  return undefined;
}
