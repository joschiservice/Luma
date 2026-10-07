/** An operational case as case workflows see it: what was detected, about what, and when. */
export interface CaseSignal {
  id: string;
  issueType: string;
  severity: 'medium' | 'high';
  /** The detected record and its scope, such as a SKU with its location and connections. */
  subject: { kind: string; id: string; scope: string[] };
  firstDetectedAt: string;
  /** Detection refreshes this whenever a fresh read confirms the case again. */
  lastDetectedAt: string;
  open: boolean;
}

/** One stored piece of case evidence. Facts are the detector's recorded values. */
export interface CaseEvidence {
  key: string;
  connectionId: string | null;
  source: {
    provider: string;
    resource: string;
    externalId: string;
    scopeKey: string;
  } | null;
  observedAt: string;
  facts: Record<string, unknown>;
}

/**
 * An owner's or admin's decision to let one built-in workflow act on cases of its type as them.
 * It grants no approval: every change still goes through policy and Action Admission.
 */
export interface CaseActivation {
  id: string;
  definitionId: string;
  version: string;
  versionDigest: string;
  principalId: string;
  policyVersion: string;
  artifactDigest: string;
  active: boolean;
  reviewedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

/** Why a run must not prepare or send a new change, or null when it may. */
export type CaseRunStop = 'activation_revoked' | 'case_resolved' | null;

/**
 * Whether detection confirmed the case recently enough to start a run. Older open cases wait
 * until the next detection pass confirms them with fresh evidence.
 */
export function caseStartable(
  signal: CaseSignal,
  maxAgeSeconds: number,
  now: number,
): boolean {
  const age = now - Date.parse(signal.lastDetectedAt);

  return (
    signal.open &&
    Number.isFinite(age) &&
    age >= 0 &&
    age < maxAgeSeconds * 1000
  );
}

/** Plain-language summary of a case run's state for readiness and Activity. */
export function caseRunOutcome(state: string | undefined): string {
  switch (state) {
    case 'verified':
      return 'The change was made and checked independently.';
    case 'ended':
      return 'The run finished without changing anything.';
    case 'awaiting_decision':
      return 'Someone else who can approve changes needs to approve the change.';
    case 'waiting':
      return 'The run is waiting before it checks again.';
    case 'escalated':
      return 'The run handed the case to a person.';
    case 'denied':
      return 'The change was rejected or is no longer allowed.';
    case 'failed_verification':
      return 'A fresh read shows a different result than expected.';
    case 'inconclusive_verification':
      return 'Luma could not confirm the result yet.';
    case 'running':
      return 'The run is in progress.';
    default:
      return 'The run is waiting to start.';
  }
}
