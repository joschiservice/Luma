import {
  shadowComparisonSchema,
  shadowEvaluationSchema,
  shadowReportSchema,
  shadowReviewSchema,
  shadowWindowSchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

export type ShadowEvaluation = ReturnType<typeof shadowEvaluationSchema.parse>;

export type ShadowComparison = ReturnType<typeof shadowComparisonSchema.parse>;

export type ShadowReview = ReturnType<typeof shadowReviewSchema.parse>;

export type ShadowReport = ReturnType<typeof shadowReportSchema.parse>;
const api = createWebApiClient();

class ShadowError extends IdentityError {
  constructor(
    status: number,
    readonly feedback: string,
  ) {
    super(status);
  }
}

function failure(result: { status: number; body: unknown }): never {
  const body = result.body;
  throw new ShadowError(
    result.status,
    body &&
      typeof body === 'object' &&
      'message' in body &&
      typeof body.message === 'string'
      ? body.message
      : 'Shadow data is unavailable. Try again.',
  );
}

/** Keeps all Shadow cache entries inside the workspace's private cache. */
export const shadowKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'shadow'] as const;

/** Reads the most recent case evaluation, including its retained review and outcome. */
export function shadowLatestOptions(
  organizationId: string,
  exceptionId: string,
  workflow: string,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...shadowKey(organizationId), 'latest', exceptionId, workflow],
    enabled: Boolean(workflow),
    queryFn: async ({ signal }) => {
      const result = await api.shadow.latest({
        params: { organizationId, exceptionId },
        query: { workflow },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return result.body.item
        ? shadowComparisonSchema.parse(result.body.item)
        : null;
    },
  });
}

/** Includes both selected calendar dates, using UTC day boundaries. Invalid ranges throw. */
export function shadowWindow(workflow: string, from: string, to: string) {
  const valid = (day: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0, 10) === day;
  if (!valid(from) || !valid(to) || from > to)
    throw new Error('Choose valid dates with the end on or after the start.');

  return shadowWindowSchema.parse({
    workflow,
    since: `${from}T00:00:00.000Z`,
    until: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString(),
  });
}

/** Reads one bounded comparison report without retaining data from a previous filter. */
export function shadowReportOptions(
  organizationId: string,
  window: ReturnType<typeof shadowWindow>,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...shadowKey(organizationId), 'report', window],
    queryFn: async ({ signal }) => {
      const result = await api.shadow.report({
        params: { organizationId },
        query: window,
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return shadowReportSchema.parse(result.body);
    },
  });
}

/** Retains a prediction without executing an action. Keep the ID for uncertain retries. */
export async function evaluateShadow(
  organizationId: string,
  exceptionId: string,
  request: { id: string; workflow: string },
) {
  const result = await api.shadow.evaluate({
    params: { organizationId, exceptionId },
    body: request,
  });
  if (result.status !== 200) return failure(result);

  return shadowEvaluationSchema.parse(result.body);
}

/** Records the first operator review; retry the identical body after an uncertain response. */
export async function reviewShadow(
  organizationId: string,
  evaluationId: string,
  review: ShadowReview,
) {
  const result = await api.shadow.review({
    params: { organizationId, evaluationId },
    body: shadowReviewSchema.parse(review),
  });
  if (result.status !== 200) return failure(result);
}

/** Extracts the comparable business action from a retained candidate, tolerating missing data. */
export function candidateAction(
  evaluation: ShadowEvaluation,
): ShadowReview['operatorAction'] {
  const action = evaluation.candidate?.action;
  if (!action || typeof action !== 'object') return null;
  const value = action as Record<string, unknown>;
  const parsed = shadowReviewSchema.shape.operatorAction.safeParse({
    capability: value.capability,
    target: value.target,
    parameters: value.parameters,
    expectedPostcondition: value.expectedPostcondition,
  });

  return parsed.success ? parsed.data : null;
}

/** Explains access loss, conflicts and uncertain writes without implying success. */
export function shadowError(error: unknown) {
  if (error instanceof IdentityError) {
    if (error.status === 401) return 'Your session expired. Sign in again.';
    if (error.status === 403)
      return 'Only workspace owners and admins can use Shadow evaluations.';
    if (error.status === 404)
      return 'This case or evaluation is no longer available.';
    if (error instanceof ShadowError) return error.feedback;
  }

  return 'The result could not be confirmed. Retry the same request to check it.';
}

/** Hides retained private data when access can no longer be confirmed. */
export function shadowAccessDenied(error: unknown) {
  return (
    error instanceof IdentityError && [401, 403, 404].includes(error.status)
  );
}
