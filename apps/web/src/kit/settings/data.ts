import { m } from '@luma/i18n/messages';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

/** Keeps server validation messages while preserving access-loss handling. */
export class SettingsError extends IdentityError {
  constructor(status: number, message: string) {
    super(status);
    this.message = message;
  }
}

/**
 * API client for settings screens. Error statuses reject with `SettingsError`, which keeps the
 * server's message so validation failures stay actionable.
 */
export const settingsApi = createWebApiClient(
  undefined,
  (status, body) =>
    new SettingsError(
      status,
      errorMessage(body) ?? m.settings_request_failed(),
    ),
);

function errorMessage(body: unknown) {
  return body &&
    typeof body === 'object' &&
    'message' in body &&
    typeof body.message === 'string'
    ? body.message
    : undefined;
}

/** Loads workspace controls and the current user's email preferences. */
export const settingsOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'settings'],
    refetchInterval: 5000,
    queryFn: ({ signal }) =>
      settingsApi.settings.get({ params: { organizationId } }, { signal }),
  });

/** Loads member identities and roles for the selected workspace. */
export const membersOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'members'],
    queryFn: async ({ signal }) =>
      (
        await settingsApi.identity.listMembers(
          { params: { organizationId } },
          { signal },
        )
      ).items,
  });

/** Loads invitations for people who can manage team members, without exposing acceptance tokens. */
export const invitationsOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'invitations'],
    refetchInterval: 5000,
    queryFn: async ({ signal }) =>
      (
        await settingsApi.settings.invitations(
          { params: { organizationId } },
          { signal },
        )
      ).items,
  });
