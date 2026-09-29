import {
  type CaseDecision,
  caseDecisionSchema,
  type CaseReview,
  caseReviewSchema,
  decisionReceiptSchema,
} from '@luma/api-contract';

import { createWebApiClient } from '../../lib/api-client';
import { IdentityError } from '../identity/data';

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
    throw new Error('This decision is no longer permitted.');
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
    throw new Error('A current proposal and policy result are required.');

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
  const result = await api.caseDesk.decide({
    params: { organizationId, exceptionId },
    body,
    extraHeaders: { 'x-luma-action-id': body.commandId },
  });
  if (result.status !== 200)
    throw new IdentityError(result.status, result.body);

  return decisionReceiptSchema.parse(result.body);
}

/** Reads the receipt for an earlier command without resubmitting the decision. */
export async function recoverDecision(
  organizationId: string,
  exceptionId: string,
  commandId: string,
) {
  const result = await api.caseDesk.receipt({
    params: { organizationId, exceptionId, commandId },
    fetchOptions: { cache: 'no-store' },
  });
  if (result.status !== 200)
    throw new IdentityError(result.status, result.body);

  return decisionReceiptSchema.parse(result.body);
}

/**
 * Returns decision feedback that distinguishes rejected requests from uncertain outcomes
 * requiring a refresh.
 */
export function decisionError(error: unknown) {
  if (error instanceof IdentityError) {
    if (error.status === 401)
      return 'Your session expired. Sign in again to review this case.';
    if (error.status === 403)
      return 'You no longer have permission to make this decision.';
    if (error.status === 404)
      return 'This case or decision is no longer available.';
    if (error.status === 409)
      return 'The proposal or case changed. Review the current state before deciding again.';
    if (error.status === 400)
      return 'The decision could not be accepted. Review the reason and current proposal.';
  }

  return 'The decision result is uncertain. Current state is being refreshed. Check the recorded decision before taking another action.';
}

/** Checks current source facts without recording a decision or executing the proposal. */
export async function refreshResolution(
  organizationId: string,
  exceptionId: string,
) {
  const unavailable =
    'We couldn’t check the latest conditions. Nothing was approved. Try again shortly.';
  const result = await api.caseDesk
    .refresh({ params: { organizationId, exceptionId }, body: {} })
    .catch(() => {
      const error = new IdentityError(503);
      error.message = unavailable;
      throw error;
    });
  if (result.status !== 200) {
    const error = new IdentityError(result.status, result.body);
    error.message =
      result.status === 409
        ? result.body.message
        : [401, 403, 404].includes(result.status)
          ? decisionError(error)
          : unavailable;
    throw error;
  }

  return caseReviewSchema.parse(result.body);
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
