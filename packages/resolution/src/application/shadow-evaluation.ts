import type { Diagnosis } from '@luma/exceptions';
import type { PolicyDecision, ProposedAction } from '@luma/policies';
import { currentPolicyVersion, evaluatePolicy } from '@luma/policies';

import type { PlaybookVersion } from '../domain/playbook.js';
import { playbookEligible } from '../domain/playbook.js';
import { simulateShadow } from '../domain/shadow.js';
import type { PlaybookRun } from './playbook.js';

export interface ShadowEvaluation {
  id: string;
  incidentId: string;
  actorId: string;
  mode: 'shadow';
  executed: false;
  createdAt: string;
  workflow: string;
  diagnosis: Diagnosis | null;
  candidate: PlaybookRun | null;
  eligibility: 'eligible' | 'ineligible' | 'stale_evidence' | 'no_candidate';
  policy:
    (Pick<PolicyDecision, 'outcome' | 'reason'> & { version: string }) | null;
  simulation: {
    modelVersion: 'shipping-method-shadow/1';
    effects: ProposedAction['expectedPostcondition'];
    predictedOutcome: 'passed' | 'inconclusive';
    evaluatorVersion: string | null;
    assumptions: string[];
  };
}

export interface ShadowReview {
  actionNeeded: boolean;
  eligible: boolean;
  operatorAction: Pick<
    ProposedAction,
    'capability' | 'target' | 'parameters' | 'expectedPostcondition'
  > | null;
  evidenceRefs: string[];
  occurredAt: string;
  feedback: 'trust' | 'distrust' | 'unsure' | null;
}

export interface ShadowComparison {
  evaluation: ShadowEvaluation;
  review: (ShadowReview & { actorId: string }) | null;
  actual: {
    outcome: 'passed' | 'failed';
    evaluatorVersion: string;
    evidenceRefs: string[];
    occurredAt: string;
  } | null;
}

/** Simulates the bounded shipping-method model without provider access or execution receipts. */
export function evaluateShadow(input: {
  id: string;
  incidentId: string;
  actorId: string;
  role: string;
  workflow: string;
  now: string;
  diagnosis: Diagnosis | null;
  candidate: PlaybookRun | null;
  version: PlaybookVersion | null;
  available: boolean;
}): ShadowEvaluation {
  const { candidate, version, diagnosis } = input;
  const eligibility =
    !candidate || !version
      ? 'no_candidate'
      : !diagnosis ||
          diagnosis.superseded ||
          diagnosis.status !== 'ready' ||
          diagnosis.detectorDecision.decision !== 'detect' ||
          candidate.diagnosisRevision !== diagnosis.revision
        ? 'ineligible'
        : diagnosis.provenance.validUntil !== null &&
            Date.parse(diagnosis.provenance.validUntil) <= Date.parse(input.now)
          ? 'stale_evidence'
          : playbookEligible(
              version.ir,
              candidate.snapshot,
              Date.parse(input.now),
            );
  const policy =
    candidate && version
      ? {
          ...evaluatePolicy(
            candidate.action,
            {
              available: input.available && eligibility === 'eligible',
              minimumRisk:
                candidate.action.capability === 'orders.shipping-method.write'
                  ? 'high'
                  : version.ir.action.minimumRisk,
            },
            input.role,
            input.actorId,
            Date.parse(input.now),
          ),
          version: currentPolicyVersion,
        }
      : null;
  if (
    policy?.outcome === 'allowed' &&
    version?.ir.approval.mode === 'required'
  ) {
    policy.outcome = 'approval_required';
    policy.reason = 'approval_required';
  }
  const simulation = simulateShadow(
    candidate?.action ?? null,
    version?.ir ?? null,
    eligibility === 'eligible' && policy?.outcome !== 'denied',
  );

  return {
    id: input.id,
    incidentId: input.incidentId,
    actorId: input.actorId,
    workflow: input.workflow,
    mode: 'shadow',
    executed: false,
    createdAt: input.now,
    diagnosis,
    candidate,
    eligibility,
    policy,
    simulation,
  };
}
