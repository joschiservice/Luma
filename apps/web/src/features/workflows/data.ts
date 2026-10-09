import type {
  ActivateCaseWorkflow,
  ActivateWorkflow,
  FireWorkflow,
  ReplenishmentPositionQuery,
  ReplenishmentPreviewRequest,
  ReplenishmentRuleInput,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

class WorkflowError extends IdentityError {
  constructor(
    status: number,
    readonly feedback: string,
  ) {
    super(status);
  }
}

/**
 * API client for workflow screens. Error statuses reject with a workflow error carrying the
 * server's message, which `workflowError` turns into feedback.
 */
export const workflowApi = createWebApiClient(
  undefined,
  (status, body) =>
    new WorkflowError(
      status,
      typeof body === 'object' &&
        body !== null &&
        'message' in body &&
        typeof body.message === 'string'
        ? body.message
        : m.workflows_error_fallback(),
    ),
);
const api = workflowApi;

/** Returns the private cache prefix for one workspace's workflows. */
export const workflowsKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'workflows'] as const;

/** Reads the persisted library; does not activate or promote a version. */
export const workflowsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: workflowsKey(organizationId),
    ...privateQueryDefaults,
    queryFn: async ({ signal }) =>
      (await api.workflows.list({ params: { organizationId } }, { signal }))
        .items,
  });

/** Reads the exact versions, grants and prerequisites for one workflow. */
export const workflowOptions = (organizationId: string, definitionId: string) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), definitionId],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.workflows.detail(
        { params: { organizationId, definitionId } },
        { signal },
      ),
  });

/**
 * Reads recent runs and the people who started them separately, so unavailable history does not
 * hide the workflow.
 */
export const workflowRunsOptions = (
  organizationId: string,
  definitionId: string,
) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), definitionId, 'runs'],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.workflows.runs(
        { params: { organizationId, definitionId } },
        { signal },
      ),
  });

/** Submits a reviewed scope. Keep the same request ID and body when retrying an uncertain response. */
export async function activateWorkflow(
  organizationId: string,
  definitionId: string,
  body: ActivateWorkflow,
) {
  return api.workflows.activate({
    params: { organizationId, definitionId },
    body,
  });
}

/**
 * Turns on a case workflow for the workspace as the signed-in person. Keep the same request ID and
 * body when retrying an uncertain response.
 */
export async function activateCaseWorkflow(
  organizationId: string,
  definitionId: string,
  body: ActivateCaseWorkflow,
) {
  return api.workflows.activateCase({
    params: { organizationId, definitionId },
    body,
  });
}

/** Permanently revokes the exact artifact; repeated submissions are safe. */
export async function revokeWorkflow(
  organizationId: string,
  definitionId: string,
  activationId: string,
  artifactDigest: string,
) {
  return api.workflows.revoke({
    params: { organizationId, definitionId, activationId },
    body: { artifactDigest },
  });
}

/** Provides actionable feedback for access loss, stale submissions and uncertain responses. */
export function workflowError(error: unknown) {
  if (error instanceof IdentityError && error.status === 401)
    return m.workflows_error_session_expired();
  if (error instanceof IdentityError && error.status === 403)
    return m.workflows_error_access_changed();
  if (error instanceof WorkflowError) return error.feedback;

  return m.workflows_error_unconfirmed();
}

/** Reads the supported Resolution catalog for case evaluation; native definitions have no evaluator yet. */
export const resolutionWorkflowsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), 'evaluation', 'library'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const { items } = await api.playbooks.list(
        { params: { organizationId } },
        { signal },
      );

      return items.map((item) => ({ ...item, category: 'resolution' }));
    },
  });

/** Starts a run; callers retain the exact body until a response is confirmed. */
export async function fireWorkflow(
  organizationId: string,
  definitionId: string,
  body: FireWorkflow,
) {
  return api.workflows.fire({
    params: { organizationId, definitionId },
    body,
  });
}

/** Cancels a scheduled start without changing its historical evidence. */
export async function cancelWorkflowStart(
  organizationId: string,
  definitionId: string,
  runId: string,
) {
  return api.workflows.cancelStart({
    params: { organizationId, definitionId, runId },
    body: {},
  });
}

/** Loads one stock choices page and readiness for the configured replenishment rules. */
export const replenishmentOptions = (
  organizationId: string,
  query: ReplenishmentPositionQuery = {},
) =>
  queryOptions({
    queryKey: [
      ...workflowsKey(organizationId),
      'inventory-replenishment',
      'setup',
      query,
    ],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.workflows.replenishmentSetup(
        {
          params: { organizationId, definitionId: 'inventory-replenishment' },
          query,
        },
        { signal },
      ),
  });

/** Checks server-owned stock and recovers an uncertain start using its request ID. */
export async function startReplenishment(
  organizationId: string,
  body: { id: string; activationId: string },
) {
  return api.workflows.startReplenishment({
    params: { organizationId, definitionId: 'inventory-replenishment' },
    body,
  });
}

/** Reads the exact proposal and whether the current operator may decide. */
export const replenishmentReviewOptions = (
  organizationId: string,
  runId: string,
) =>
  queryOptions({
    queryKey: [
      ...workflowsKey(organizationId),
      'inventory-replenishment',
      'review',
      runId,
    ],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.workflows.replenishmentReview(
        {
          params: {
            organizationId,
            definitionId: 'inventory-replenishment',
            runId,
          },
        },
        { signal },
      ),
  });

/** Records a decision against the reviewed proposal, without granting authority to later proposals. */
export async function decideReplenishment(
  organizationId: string,
  runId: string,
  body: { decisionId: string; outcome: 'approved' | 'rejected' },
) {
  return api.workflows.decideReplenishment({
    params: { organizationId, definitionId: 'inventory-replenishment', runId },
    body,
  });
}

/** Checks proposed stock rules against current stock and rules. It changes nothing. */
export async function previewReplenishment(
  organizationId: string,
  body: ReplenishmentPreviewRequest,
) {
  return api.workflows.previewReplenishment({
    params: { organizationId, definitionId: 'inventory-replenishment' },
    body,
  });
}

/**
 * Activates reviewed rules, each on its own. Resend the same items after an uncertain response;
 * activated rules come back unchanged and are never duplicated.
 */
export async function configureReplenishmentBatch(
  organizationId: string,
  items: ReplenishmentRuleInput[],
) {
  return (
    await api.workflows.configureReplenishmentBatch({
      params: { organizationId, definitionId: 'inventory-replenishment' },
      body: { items },
    })
  ).results;
}

/** Reads how workflows cover one stock position, with readiness scoped to it. */
export const workflowCoverageOptions = (
  organizationId: string,
  positionId: string,
) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), 'coverage', positionId],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) =>
      (
        await api.workflows.coverage(
          {
            params: { organizationId },
            query: { subjectKind: 'inventory_position', subjectId: positionId },
          },
          { signal },
        )
      ).items,
  });
