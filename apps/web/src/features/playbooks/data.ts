import {
  type ActivatePlaybook,
  playbookActivationSchema,
  playbookDetailSchema,
  playbookRunViewSchema,
  playbookSummarySchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

class PlaybookError extends IdentityError {
  constructor(
    status: number,
    readonly feedback: string,
  ) {
    super(status);
  }
}

function failure(result: { status: number; body: unknown }): never {
  const message =
    typeof result.body === 'object' &&
    result.body !== null &&
    'message' in result.body &&
    typeof result.body.message === 'string'
      ? result.body.message
      : 'Reload to check the current playbook state.';
  throw new PlaybookError(result.status, message);
}

/** Returns the private cache prefix for one workspace's playbooks. */
export const playbooksKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'playbooks'] as const;

/** Reads the persisted library; does not activate or promote a version. */
export const playbooksOptions = (organizationId: string) =>
  queryOptions({
    queryKey: playbooksKey(organizationId),
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.playbooks.list({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return result.body.items.map((item) => playbookSummarySchema.parse(item));
    },
  });

/** Reads the exact versions, grants and prerequisites for one playbook. */
export const playbookOptions = (organizationId: string, definitionId: string) =>
  queryOptions({
    queryKey: [...playbooksKey(organizationId), definitionId],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.playbooks.detail({
        params: { organizationId, definitionId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return playbookDetailSchema.parse(result.body);
    },
  });

/** Reads recent runs separately so unavailable history does not hide the playbook. */
export const playbookRunsOptions = (
  organizationId: string,
  definitionId: string,
) =>
  queryOptions({
    queryKey: [...playbooksKey(organizationId), definitionId, 'runs'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.playbooks.runs({
        params: { organizationId, definitionId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return result.body.items.map((item) => playbookRunViewSchema.parse(item));
    },
  });

/** Submits a reviewed scope. Keep the same request ID and body when retrying an uncertain response. */
export async function activatePlaybook(
  organizationId: string,
  definitionId: string,
  body: ActivatePlaybook,
) {
  const result = await api.playbooks.activate({
    params: { organizationId, definitionId },
    body,
  });
  if (result.status !== 200) return failure(result);

  return playbookActivationSchema.parse(result.body);
}

/** Permanently revokes the exact artifact; repeated submissions are safe. */
export async function revokePlaybook(
  organizationId: string,
  definitionId: string,
  activationId: string,
  artifactDigest: string,
) {
  const result = await api.playbooks.revoke({
    params: { organizationId, definitionId, activationId },
    body: { artifactDigest },
  });
  if (result.status !== 200) return failure(result);

  return playbookActivationSchema.parse(result.body);
}

/** Provides actionable feedback for access loss, stale submissions and uncertain responses. */
export function playbookError(error: unknown) {
  if (error instanceof IdentityError && error.status === 401)
    return 'Your session expired. Sign in again.';
  if (error instanceof IdentityError && error.status === 403)
    return 'Workspace access changed. Refresh to check your permissions.';
  if (error instanceof PlaybookError) return error.feedback;

  return 'The result could not be confirmed. Check your connection, then retry the same request or refresh to inspect its status.';
}
