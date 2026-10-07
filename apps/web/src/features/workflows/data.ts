import {
  type ActivateCaseWorkflow,
  type ActivateWorkflow,
  playbookSummarySchema,
  replenishmentBatchResultSchema,
  type ReplenishmentPreviewRequest,
  replenishmentPreviewSchema,
  type ReplenishmentRuleInput,
  workflowActivationSchema,
  workflowCoverageSchema,
  workflowDetailSchema,
  workflowRunViewSchema,
  workflowSummarySchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

class WorkflowError extends IdentityError {
  constructor(
    status: number,
    readonly feedback: string,
  ) {
    super(status);
  }
}

/** Throws a workflow error carrying the server's message for a non-200 result. */
function failure(result: { status: number; body: unknown }): never {
  const message =
    typeof result.body === 'object' &&
    result.body !== null &&
    'message' in result.body &&
    typeof result.body.message === 'string'
      ? result.body.message
      : 'Reload to check the current workflow state.';
  throw new WorkflowError(result.status, message);
}

/** Returns the private cache prefix for one workspace's workflows. */
export const workflowsKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'workflows'] as const;

/** Reads the persisted library; does not activate or promote a version. */
export const workflowsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: workflowsKey(organizationId),
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.workflows.list({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return result.body.items.map((item) => workflowSummarySchema.parse(item));
    },
  });

/** Reads the exact versions, grants and prerequisites for one workflow. */
export const workflowOptions = (organizationId: string, definitionId: string) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), definitionId],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.workflows.detail({
        params: { organizationId, definitionId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return workflowDetailSchema.parse(result.body);
    },
  });

/** Reads recent runs separately so unavailable history does not hide the workflow. */
export const workflowRunsOptions = (
  organizationId: string,
  definitionId: string,
) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), definitionId, 'runs'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.workflows.runs({
        params: { organizationId, definitionId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return result.body.items.map((item) => workflowRunViewSchema.parse(item));
    },
  });

/** Submits a reviewed scope. Keep the same request ID and body when retrying an uncertain response. */
export async function activateWorkflow(
  organizationId: string,
  definitionId: string,
  body: ActivateWorkflow,
) {
  const result = await api.workflows.activate({
    params: { organizationId, definitionId },
    body,
  });
  if (result.status !== 200) return failure(result);

  return workflowActivationSchema.parse(result.body);
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
  const result = await api.workflows.activateCase({
    params: { organizationId, definitionId },
    body,
  });
  if (result.status !== 200) return failure(result);

  return workflowActivationSchema.parse(result.body);
}

/** Permanently revokes the exact artifact; repeated submissions are safe. */
export async function revokeWorkflow(
  organizationId: string,
  definitionId: string,
  activationId: string,
  artifactDigest: string,
) {
  const result = await api.workflows.revoke({
    params: { organizationId, definitionId, activationId },
    body: { artifactDigest },
  });
  if (result.status !== 200) return failure(result);

  return workflowActivationSchema.parse(result.body);
}

/** Provides actionable feedback for access loss, stale submissions and uncertain responses. */
export function workflowError(error: unknown) {
  if (error instanceof IdentityError && error.status === 401)
    return 'Your session expired. Sign in again.';
  if (error instanceof IdentityError && error.status === 403)
    return 'Workspace access changed. Refresh to check your permissions.';
  if (error instanceof WorkflowError) return error.feedback;

  return 'The result could not be confirmed. Check your connection, then retry the same request or refresh to inspect its status.';
}

/** Reads the supported Resolution catalog for case evaluation; native definitions have no evaluator yet. */
export const resolutionWorkflowsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), 'evaluation', 'library'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.playbooks.list({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return result.body.items.map((item) => ({
        ...playbookSummarySchema.parse(item),
        category: 'resolution',
      }));
    },
  });

/** Starts a run; callers retain the exact body until a response is confirmed. */
export async function fireWorkflow(
  organizationId: string,
  definitionId: string,
  body: import('@luma/api-contract').FireWorkflow,
) {
  const result = await api.workflows.fire({
    params: { organizationId, definitionId },
    body,
  });
  if (result.status !== 200) return failure(result);

  return workflowRunViewSchema.parse(result.body);
}

/** Cancels a scheduled start without changing its historical evidence. */
export async function cancelWorkflowStart(
  organizationId: string,
  definitionId: string,
  runId: string,
) {
  const result = await api.workflows.cancelStart({
    params: { organizationId, definitionId, runId },
    body: {},
  });
  if (result.status !== 200) return failure(result);

  return workflowRunViewSchema.parse(result.body);
}

/** Loads replenishment stock choices and activation rules in one request. */
export const replenishmentOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [
      ...workflowsKey(organizationId),
      'inventory-replenishment',
      'setup',
    ],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.workflows.replenishmentSetup({
        params: { organizationId, definitionId: 'inventory-replenishment' },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return result.body;
    },
  });

/** Checks server-owned stock and recovers an uncertain start using its request ID. */
export async function startReplenishment(
  organizationId: string,
  body: { id: string; activationId: string },
) {
  const result = await api.workflows.startReplenishment({
    params: { organizationId, definitionId: 'inventory-replenishment' },
    body,
  });
  if (result.status !== 200) return failure(result);

  return result.body;
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
    queryFn: async ({ signal }) => {
      const result = await api.workflows.replenishmentReview({
        params: {
          organizationId,
          definitionId: 'inventory-replenishment',
          runId,
        },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return result.body;
    },
  });

/** Records a decision against the reviewed proposal, without granting authority to later proposals. */
export async function decideReplenishment(
  organizationId: string,
  runId: string,
  body: { decisionId: string; outcome: 'approved' | 'rejected' },
) {
  const result = await api.workflows.decideReplenishment({
    params: { organizationId, definitionId: 'inventory-replenishment', runId },
    body,
  });
  if (result.status !== 200) return failure(result);

  return result.body;
}

/** Checks proposed stock rules against current stock and rules. It changes nothing. */
export async function previewReplenishment(
  organizationId: string,
  body: ReplenishmentPreviewRequest,
) {
  const result = await api.workflows.previewReplenishment({
    params: { organizationId, definitionId: 'inventory-replenishment' },
    body,
  });
  if (result.status !== 200) return failure(result);

  return replenishmentPreviewSchema.parse(result.body);
}

/**
 * Activates reviewed rules, each on its own. Resend the same items after an uncertain response;
 * activated rules come back unchanged and are never duplicated.
 */
export async function configureReplenishmentBatch(
  organizationId: string,
  items: ReplenishmentRuleInput[],
) {
  const result = await api.workflows.configureReplenishmentBatch({
    params: { organizationId, definitionId: 'inventory-replenishment' },
    body: { items },
  });
  if (result.status !== 200) return failure(result);

  return replenishmentBatchResultSchema.parse(result.body).results;
}

/** Reads how workflows cover one stock position, with readiness scoped to it. */
export const workflowCoverageOptions = (
  organizationId: string,
  positionId: string,
) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), 'coverage', positionId],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.workflows.coverage({
        params: { organizationId },
        query: { subjectKind: 'inventory_position', subjectId: positionId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return workflowCoverageSchema.parse(result.body).items;
    },
  });

/** Converts a non-200 API result into a workflow error with the server's message. */
export const workflowFailure = failure;
