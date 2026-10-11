import type { CodeEvaluation, EvaluateCode } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { queryOptions } from '@tanstack/react-query';

import { IdentityError } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { workflowsKey } from './data';

/** A rejected fixture can be edited; uncertain requests must retain their identity. */
export class CodeEvaluationRejected extends Error {}

// Access failures keep their status; rejected inputs can be edited; anything else is uncertain.
function failure(status: number, body: unknown): Error {
  if ([401, 403, 404].includes(status)) return new IdentityError(status, body);
  const Failure = [400, 409, 422].includes(status)
    ? CodeEvaluationRejected
    : Error;

  return new Failure(
    typeof body === 'object' && body && 'message' in body
      ? String(body.message)
      : m.workflows_code_no_response(),
  );
}

const api = createWebApiClient(undefined, failure);

/** Starts one evaluation; reuse its request ID and inputs when retrying. */
export async function evaluateCode(
  organizationId: string,
  definitionId: string,
  body: EvaluateCode,
) {
  return api.workflows.evaluateCode({
    params: { organizationId, definitionId },
    body,
  });
}

/** Polls a private evaluation until it reaches a terminal state. */
export function codeEvaluationOptions(
  organizationId: string,
  definitionId: string,
  evaluationId: string,
) {
  return queryOptions<CodeEvaluation>({
    ...privateQueryDefaults,
    queryKey: [
      ...workflowsKey(organizationId),
      definitionId,
      'code-evaluations',
      evaluationId,
    ],
    enabled: !!evaluationId,
    refetchInterval: (query) =>
      query.state.data?.state === 'running' ? 500 : false,
    queryFn: ({ signal }) =>
      api.workflows.codeEvaluation(
        { params: { organizationId, definitionId, evaluationId } },
        { signal },
      ),
  });
}

/** Requests cancellation without removing the evaluation's evidence. */
export async function cancelCodeEvaluation(
  organizationId: string,
  definitionId: string,
  evaluationId: string,
) {
  return api.workflows.cancelCodeEvaluation({
    params: { organizationId, definitionId, evaluationId },
    body: {},
  });
}

/** Stops further code requests; previously admitted actions retain their reconciliation path. */
export async function cancelCodeStep(
  organizationId: string,
  definitionId: string,
  runId: string,
  stepId: string,
) {
  await api.workflows.cancelCodeStep({
    params: { organizationId, definitionId, runId, stepId },
    body: {},
  });
}
