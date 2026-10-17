import type { DiagnosisService } from '@luma/exceptions';
import type { BoundActionStep } from '@luma/execution';
import type { TenantContext } from '@luma/identity';

/** Recheck the bound diagnosis and its evidence independently of workflow decisions. */
export function createAdmissionEligibility(
  diagnoses: Pick<DiagnosisService, 'get'>,
  maxEvidenceAgeMs = 5 * 60_000,
) {
  if (!Number.isFinite(maxEvidenceAgeMs) || maxEvidenceAgeMs <= 0)
    throw new Error('Evidence freshness window must be positive');

  return async (context: TenantContext, step: BoundActionStep) => {
    if (!step.incidentId || step.subject) return false;
    const diagnosis = await diagnoses.get(context, step.incidentId);
    const now = Date.now();

    return (
      !!diagnosis &&
      diagnosis.exceptionId === step.incidentId &&
      !diagnosis.superseded &&
      diagnosis.status === 'ready' &&
      diagnosis.revision === step.diagnosisRevision &&
      (diagnosis.provenance.validUntil === null ||
        Date.parse(diagnosis.provenance.validUntil) > now) &&
      Date.parse(step.action.preconditions.validUntil) > now &&
      step.action.preconditions.evidenceRefs.every((id) => {
        const evidence = diagnosis.provenance.evidence.find(
          (evidence) => evidence.id === id,
        );
        const observedAt = Date.parse(evidence?.observedAt ?? '');

        return observedAt <= now && observedAt + maxEvidenceAgeMs > now;
      })
    );
  };
}

/**
 * Admission subjects whose owner decides eligibility. Each owner's admission adapter binds its
 * steps with its kind; a subject of any other kind is a replenishment step.
 */
const ownedAdmissionSubjects = [
  'purchase_order_change',
  'purchasing_plan',
  'purchase_order_submission',
  'message_outbound',
  'return_case_creation',
  'return_case_settlement',
  'return_case_exchange',
  'supplier_follow_up',
] as const;

/** A subject kind routed to its owner's eligibility check. */
export type OwnedAdmissionSubject = (typeof ownedAdmissionSubjects)[number];

type Eligible = (
  context: TenantContext,
  step: BoundActionStep,
) => Promise<boolean>;

function isOwnedSubject(kind: string): kind is OwnedAdmissionSubject {
  return (ownedAdmissionSubjects as readonly string[]).includes(kind);
}

/**
 * Routes an admitted step to the owner that decides its eligibility: field writes first, then
 * the owner of the step's subject kind. A subject of another kind goes to `otherSubject`; a step
 * without a subject is a resolution proposal and goes to `noSubject`.
 */
export function routeAdmissionEligibility(routes: {
  fieldWrite: { matches(capability: string): boolean; eligible: Eligible };
  subjects: Record<OwnedAdmissionSubject, Eligible>;
  otherSubject: Eligible;
  noSubject: Eligible;
}): Eligible {
  return (context, step) => {
    if (routes.fieldWrite.matches(step.action.capability))
      return routes.fieldWrite.eligible(context, step);
    if (!step.subject) return routes.noSubject(context, step);
    if (isOwnedSubject(step.subject.kind))
      return routes.subjects[step.subject.kind](context, step);

    return routes.otherSubject(context, step);
  };
}
