import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

export const settingsApi = createWebApiClient();

/** Keeps server validation messages while preserving access-loss handling. */
export class SettingsError extends IdentityError {
  constructor(status: number, message: string) {
    super(status);
    this.message = message;
  }
}

/** Unwraps an API response and retains actionable server errors. */
export function settingsResult(result: {
  status: number;
  body: unknown;
}): unknown {
  if (result.status >= 400) {
    const body = result.body as { message?: string };
    throw new SettingsError(
      result.status,
      body.message ?? 'The request could not be completed.',
    );
  }

  return result.body;
}

/** Loads workspace controls and the current user's email preferences. */
export const settingsOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'settings'],
    refetchInterval: 5000,
    queryFn: async ({ signal }) => {
      const result = await settingsApi.settings.get({
        params: { organizationId },
        fetchOptions: { signal },
      });
      if (result.status !== 200)
        throw new SettingsError(result.status, result.body.message);

      return result.body;
    },
  });

/** Loads member identities and roles for the selected workspace. */
export const membersOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'members'],
    queryFn: async ({ signal }) => {
      const result = await settingsApi.identity.listMembers({
        params: { organizationId },
        fetchOptions: { signal },
      });
      if (result.status !== 200)
        throw new SettingsError(result.status, result.body.message);

      return result.body.items;
    },
  });

/** Loads invitations for workspace administrators without exposing acceptance tokens. */
export const invitationsOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'invitations'],
    refetchInterval: 5000,
    queryFn: async ({ signal }) => {
      const result = await settingsApi.settings.invitations({
        params: { organizationId },
        fetchOptions: { signal },
      });
      if (result.status !== 200)
        throw new SettingsError(result.status, result.body.message);

      return result.body.items;
    },
  });
