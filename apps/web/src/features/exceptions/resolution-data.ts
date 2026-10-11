import {
  type CaseDecision,
  caseDecisionSchema,
  type CaseReview,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

import { IdentityError } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';

const api = createWebApiClient();

/**
 * Builds a validated, revision-bound decision; rejects unavailable decisions or missing
 * proposal policy data.
 */
export function decisionCommand(
  review: CaseReview,
  kind: CaseDecision['kind'],
  reason: string,
  commandId = crypto.randomUUID(),
): CaseDecision {
  if (!review.permittedDecisions.includes(kind))
    throw new Error(m.exceptions_decision_not_permitted());
  const common = {
    commandId,
    kind,
    reason,
    caseRevision: review.caseRevision,
    diagnosisRevision: review.diagnosisRevision,
  };
  if (kind === 'escalate') return caseDecisionSchema.parse(common);
  const proposal = review.proposal;
  if (!proposal?.policy)
    throw new Error(m.exceptions_decision_needs_proposal());

  return caseDecisionSchema.parse({
    ...common,
    proposalId: proposal.id,
    proposalVersion: proposal.version,
    decisionId: proposal.policy.id,
  });
}

/** Submits a decision using its command ID for correlation and returns the validated receipt. */
export async function sendDecision(
  organizationId: string,
  exceptionId: string,
  body: CaseDecision,
) {
  return api.caseDesk.decide(
    { params: { organizationId, exceptionId }, body },
    { context: { headers: { 'x-luma-action-id': body.commandId } } },
  );
}

/** Reads the receipt for an earlier command without resubmitting the decision. */
export async function recoverDecision(
  organizationId: string,
  exceptionId: string,
  commandId: string,
) {
  return api.caseDesk.receipt({
    params: { organizationId, exceptionId, commandId },
  });
}

/**
 * Returns decision feedback that distinguishes rejected requests from uncertain outcomes
 * requiring a refresh.
 */
export function decisionError(error: unknown) {
  if (error instanceof IdentityError) {
    if (error.status === 401) return m.exceptions_decision_error_session();
    if (error.status === 403) return m.exceptions_decision_error_permission();
    if (error.status === 404) return m.exceptions_decision_error_missing();
    if (error.status === 409) return m.exceptions_decision_error_conflict();
    if (error.status === 400) return m.exceptions_decision_error_invalid();
  }

  return m.exceptions_decision_error_unclear();
}

/**
 * Checks current source facts without recording a decision or executing the proposal. A 409
 * keeps the server's description of the changed conditions; failures without a response, such
 * as network errors, reject with a retryable 503.
 */
export async function refreshResolution(
  organizationId: string,
  exceptionId: string,
) {
  const unavailable = m.exceptions_refresh_unavailable();
  try {
    return await api.caseDesk.refresh({
      params: { organizationId, exceptionId },
      body: {},
    });
  } catch (cause) {
    if (!(cause instanceof IdentityError)) {
      const error = new IdentityError(503);
      error.message = unavailable;
      throw error;
    }
    if (cause.status !== 409)
      cause.message = [401, 403, 404].includes(cause.status)
        ? decisionError(cause)
        : unavailable;
    throw cause;
  }
}

/** Compares the decision's scope, excluding evidence timestamps and immutable revision identifiers. */
export function sameResolution(left: CaseReview, right: CaseReview) {
  const scope = (review: CaseReview) => {
    const p = review.proposal;
    if (!p) return null;

    return [
      p.version,
      p.capability,
      p.capabilityVersion,
      p.connectionId,
      p.target.kind,
      p.target.id,
      Object.entries(p.parameters).sort(),
      Object.entries(p.expectedPostcondition).sort(),
      p.risk,
      p.requestedBy,
      p.policy?.policyVersion,
    ];
  };

  return (
    Boolean(left.proposal && right.proposal) &&
    JSON.stringify(scope(left)) === JSON.stringify(scope(right))
  );
}
