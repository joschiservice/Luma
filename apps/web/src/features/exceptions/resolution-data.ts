import {
  type CaseDecision,
  caseDecisionSchema,
  caseProgressSchema,
  type CaseReview,
  caseReviewSchema,
  decisionReceiptSchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';
import { casesKey } from './data';

const api = createWebApiClient();

/** Loads proposal review and execution progress together, refreshing every five seconds. */
export function resolutionOptions(organizationId: string, exceptionId: string) {
  return queryOptions({
    queryKey: [...casesKey(organizationId), 'resolution', exceptionId],
    ...privateQueryDefaults,
    refetchOnWindowFocus: 'always',
    refetchInterval: 5000,
    queryFn: async ({ signal }) => {
      const args = {
        params: { organizationId, exceptionId },
        fetchOptions: { signal, cache: 'no-store' as const },
      };
      const [review, progress] = await Promise.all([
        api.caseDesk.review(args),
        api.caseDesk.progress(args),
      ]);
      if (review.status !== 200) throw new IdentityError(review.status);
      if (progress.status !== 200) throw new IdentityError(progress.status);

      return {
        review: caseReviewSchema.parse(review.body),
        progress: caseProgressSchema.parse(progress.body),
      };
    },
  });
}

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
  if (result.status !== 200) throw new IdentityError(result.status);

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
  if (result.status !== 200) throw new IdentityError(result.status);

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
