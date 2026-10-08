import {
  type CodeEvaluation,
  codeEvaluationSchema,
  type EvaluateCode,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';
import { workflowsKey } from './data';

const api = createWebApiClient();

/** A rejected fixture can be edited; uncertain requests must retain their identity. */
export class CodeEvaluationRejected extends Error {}

function failure(result: { status: number; body: unknown }): never {
  if ([401, 403, 404].includes(result.status))
    throw new IdentityError(result.status, result.body);
  const Failure = [400, 409, 422].includes(result.status)
    ? CodeEvaluationRejected
    : Error;
  throw new Failure(
    typeof result.body === 'object' && result.body && 'message' in result.body
      ? String(result.body.message)
      : m.workflows_code_no_response(),
  );
}

/** Starts one evaluation; reuse its request ID and inputs when retrying. */
export async function evaluateCode(
  organizationId: string,
  definitionId: string,
  body: EvaluateCode,
) {
  const result = await api.workflows.evaluateCode({
    params: { organizationId, definitionId },
    body,
  });
  if (result.status !== 200) return failure(result);

  return codeEvaluationSchema.parse(result.body);
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
    queryFn: async ({ signal }) => {
      const result = await api.workflows.codeEvaluation({
        params: { organizationId, definitionId, evaluationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return codeEvaluationSchema.parse(result.body);
    },
  });
}

/** Requests cancellation without removing the evaluation's evidence. */
export async function cancelCodeEvaluation(
  organizationId: string,
  definitionId: string,
  evaluationId: string,
) {
  const result = await api.workflows.cancelCodeEvaluation({
    params: { organizationId, definitionId, evaluationId },
    body: {},
  });
  if (result.status !== 200) return failure(result);

  return codeEvaluationSchema.parse(result.body);
}

/** Stops further code requests; previously admitted actions retain their reconciliation path. */
export async function cancelCodeStep(
  organizationId: string,
  definitionId: string,
  runId: string,
  stepId: string,
) {
  const result = await api.workflows.cancelCodeStep({
    params: { organizationId, definitionId, runId, stepId },
    body: {},
  });
  if (result.status !== 200) return failure(result);
}
