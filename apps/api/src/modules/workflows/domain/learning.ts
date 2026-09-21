export interface ResolutionSelection {
  id: string;
  version: string;
  use: 'created' | 'improved' | 'reused' | 'partner_specific';
  reasonCode: string;
  previousVersion?: string | undefined;
  partnerCodeRef?: string | undefined;
}

export interface StartResolutionRun {
  id: string;
  diagnosisRevision: number;
  resolution: ResolutionSelection;
}

export type LearningFact =
  | {
      kind: 'cause';
      code: string;
      status: 'suspected' | 'confirmed' | 'rejected';
      supportingEvidenceRefs: string[];
      contradictingEvidenceRefs: string[];
      basis: 'model_hypothesis' | 'operator_investigation';
    }
  | {
      kind: 'repair_step';
      stepId: string;
      actionCode: string;
      inputEvidenceRefs: string[];
      actionHash: string;
      startedAt: string;
      finishedAt: string;
      effortSeconds: number;
      result: 'accepted' | 'failed' | 'unknown';
    }
  | {
      kind: 'intervention';
      stepId: string;
      reasonCode: string;
      effortSeconds: number;
      evidenceRefs: string[];
    }
  | {
      kind: 'observation';
      stepId: string;
      code: string;
      evidenceRefs: string[];
    }
  | {
      kind: 'human_edit';
      stepId: string;
      beforeHash: string;
      afterHash: string;
      reasonCode: string;
      evidenceRefs: string[];
    }
  | {
      kind: 'outcome';
      result: 'pending' | 'failed' | 'inconclusive' | 'verified';
      evaluatorVersion: string;
      authoritative: boolean;
      complete: boolean;
      evidenceRefs: string[];
      businessResult: {
        code: string;
        value: number | null;
        unit: string | null;
      };
    }
  | { kind: 'recurrence'; incidentId: string; evidenceRefs: string[] };

export interface LearningCommand {
  id: string;
  occurredAt: string;
  fact: LearningFact;
}

export interface LearningEvent extends LearningCommand {
  sequence: number;
  actorId: string;
  recordedAt: string;
}

/** Retained binding and artifact availability for a resolution selection. */
export interface LearningSelectionFacts {
  binding: {
    incidentId: string;
    diagnosisRevision: number;
    artifactId: string;
    artifactVersion: string;
  } | null;
  artifactActive: boolean;
  previousVersionExists: boolean;
}

/** Canonical incident verification relevant to an operator's claimed outcome. */
export interface LearningVerification {
  outcome: 'passed' | 'failed' | 'inconclusive';
  authoritative: boolean;
  complete: boolean;
  evaluatorVersion: string;
  evidenceRefs: string[];
  at: string;
}

/** Persisted facts needed to accept a learning event, read within its recording transaction. */
export interface LearningEventFacts {
  recordedAt: string;
  ownedEvidenceRefs: string[];
  stepExists: boolean;
  verification: LearningVerification | null;
  recurrenceExists: boolean;
}

/** Returns the distinct evidence references whose incident ownership must be checked. */
export function learningEvidence(fact: LearningFact): string[] {
  const refs =
    fact.kind === 'cause'
      ? [...fact.supportingEvidenceRefs, ...fact.contradictingEvidenceRefs]
      : fact.kind === 'repair_step'
        ? fact.inputEvidenceRefs
        : fact.evidenceRefs;

  return [...new Set(refs)];
}

/** Returns a selection conflict, or null when the validated command matches retained facts. */
export function learningSelectionConflict(
  incidentId: string,
  input: StartResolutionRun,
  facts: LearningSelectionFacts,
): string | null {
  const binding = facts.binding;
  if (
    binding &&
    (binding.incidentId !== incidentId ||
      binding.diagnosisRevision !== input.diagnosisRevision ||
      binding.artifactId !== input.resolution.id ||
      binding.artifactVersion !== input.resolution.version)
  )
    return 'Resolution run binding conflicts';
  if (!facts.artifactActive && !binding)
    return 'Selected resolution is revoked';
  if (input.resolution.previousVersion && !facts.previousVersionExists)
    return 'Previous resolution version not found';

  return null;
}

/** Returns an event conflict, or null when the validated command matches retained facts. */
export function learningEventConflict(
  input: LearningCommand,
  facts: LearningEventFacts,
): string | null {
  if (Date.parse(input.occurredAt) > Date.parse(facts.recordedAt))
    return 'Observation time is in the future';
  if (
    !learningEvidence(input.fact).every((ref) =>
      facts.ownedEvidenceRefs.includes(ref),
    )
  )
    return 'Evidence must belong to this incident';
  const fact = input.fact;
  if ('stepId' in fact) {
    if (fact.kind === 'repair_step' && facts.stepExists)
      return 'Step ID is already bound';
    if (fact.kind !== 'repair_step' && !facts.stepExists)
      return 'Step not found';
  }
  if (fact.kind === 'outcome' && fact.result === 'verified') {
    const resolution = facts.verification;
    // Operator assertions cannot upgrade action acceptance into verified incident resolution.
    if (
      !resolution ||
      resolution.outcome !== 'passed' ||
      !resolution.authoritative ||
      !resolution.complete ||
      resolution.evaluatorVersion !== fact.evaluatorVersion ||
      !fact.evidenceRefs.every((ref) =>
        resolution.evidenceRefs.includes(ref),
      ) ||
      Date.parse(input.occurredAt) < Date.parse(resolution.at)
    )
      return 'A verified outcome requires the incident’s authoritative verification';
  }
  if (fact.kind === 'recurrence' && !facts.recurrenceExists)
    return 'Incident is not a recorded recurrence of this case';

  return null;
}
