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
