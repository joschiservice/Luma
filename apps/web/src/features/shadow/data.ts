import {
  shadowComparisonSchema,
  shadowEvaluationSchema,
  shadowReportSchema,
  shadowReviewSchema,
  shadowWindowSchema,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { nextCalendarDay, workspaceInstant } from '@luma/ui/lib/timezone';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

export type ShadowEvaluation = ReturnType<typeof shadowEvaluationSchema.parse>;

export type ShadowComparison = ReturnType<typeof shadowComparisonSchema.parse>;

export type ShadowReview = ReturnType<typeof shadowReviewSchema.parse>;

export type ShadowReport = ReturnType<typeof shadowReportSchema.parse>;

class ShadowError extends IdentityError {
  constructor(
    status: number,
    readonly feedback: string,
  ) {
    super(status);
  }
}

/** Keeps the server's message as feedback for error statuses. */
function failure(status: number, body: unknown) {
  return new ShadowError(
    status,
    body &&
      typeof body === 'object' &&
      'message' in body &&
      typeof body.message === 'string'
      ? body.message
      : m.shadow_error_unavailable(),
  );
}

const api = createWebApiClient('/api', failure);

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
      const result = await api.shadow.latest(
        { params: { organizationId, exceptionId }, query: { workflow } },
        { signal },
      );

      return result.item;
    },
  });
}

/** Includes both selected calendar dates, using workspace day boundaries. Invalid ranges throw. */
export function shadowWindow(
  workflow: string,
  from: string,
  to: string,
  timeZone = 'UTC',
) {
  const valid = (day: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0, 10) === day;
  if (!valid(from) || !valid(to) || from > to)
    throw new Error(m.shadow_error_dates());

  return shadowWindowSchema.parse({
    workflow,
    since: workspaceInstant(from, timeZone),
    until: workspaceInstant(nextCalendarDay(to), timeZone),
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
    queryFn: ({ signal }) =>
      api.shadow.report(
        { params: { organizationId }, query: window },
        { signal },
      ),
  });
}

/** Retains a prediction without executing an action. Keep the ID for uncertain retries. */
export async function evaluateShadow(
  organizationId: string,
  exceptionId: string,
  request: { id: string; workflow: string },
) {
  return api.shadow.evaluate({
    params: { organizationId, exceptionId },
    body: request,
  });
}

/** Records the first operator review; retry the identical body after an uncertain response. */
export async function reviewShadow(
  organizationId: string,
  evaluationId: string,
  review: ShadowReview,
) {
  await api.shadow.review({
    params: { organizationId, evaluationId },
    body: shadowReviewSchema.parse(review),
  });
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
    if (error.status === 401) return m.shadow_error_session();
    if (error.status === 403) return m.shadow_error_role();
    if (error.status === 404) return m.shadow_error_not_found();
    if (error instanceof ShadowError) return error.feedback;
  }

  return m.shadow_error_unconfirmed();
}

/** Hides retained private data when access can no longer be confirmed. */
export function shadowAccessDenied(error: unknown) {
  return (
    error instanceof IdentityError && [401, 403, 404].includes(error.status)
  );
}
