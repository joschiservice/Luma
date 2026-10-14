import type {
  staffAccountDeletionCategorySchema,
  staffAccountDisableCategorySchema,
} from '@luma/api-contract/staff';
import {
  staffAccessGrantSchema,
  staffAccessHistorySchema,
  staffAccountAccessSchema,
  staffAccountChangeSchema,
  staffAccountDeletionChangeSchema,
  staffAccountDetailSchema,
  staffAccountSecurityEventsSchema,
  staffAuditPageSchema,
  staffConfigSchema,
  staffDirectorySchema,
  staffMembershipChangeSchema,
  staffRevokeSessionsResultSchema,
  staffSessionSchema,
  staffSupportAccessRequestSchema,
  staffSupportViewSchema,
  staffWorkspaceDetailSchema,
  staffWorkspaceHealthSchema,
  staffWorkspacePlacementSchema,
} from '@luma/api-contract/staff';
import { useSearch } from '@tanstack/react-router';
import type { z } from 'zod';

import { staffActivity } from './activity';
import {
  regionalFetch,
  staffPath,
  type StaffRegion,
  staffRegion,
} from './regions';

/** A rejected staff request. Status zero means no response arrived. */
export class StaffApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'StaffApiError';
  }
}

/** Returns a user-readable failure without exposing provider or database errors. */
export function errorMessage(error: unknown) {
  return error instanceof StaffApiError
    ? error.message
    : 'The staff service returned an unexpected response. Refresh and try again.';
}

function failureMessage(status: number, path: string) {
  if (status === 401 && path === 'auth/sign-in/email')
    return 'Sign-in failed. Check your email and password.';
  if (status === 403 && path === 'session')
    return 'This account does not have active staff access.';
  if (status === 401) return 'Your staff session expired. Sign in again.';
  if (status === 403)
    return 'You do not have access to this operation. Your support access may have expired.';
  if (status === 404) return 'This record could not be found.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status === 400)
    return 'The request could not be accepted. Check the fields and try again.';

  return 'The staff service could not complete this request. Try again.';
}

// Conflicts explain which state blocked the command; the staff API writes these messages.
async function conflictMessage(response: Response) {
  try {
    const body: unknown = await response.json();

    return body &&
      typeof body === 'object' &&
      'message' in body &&
      typeof body.message === 'string' &&
      body.message.length <= 300
      ? body.message
      : null;
  } catch {
    return null;
  }
}

/**
 * Creates an isolated staff API client with an injectable regional fetcher. Cookies stay HTTP-only and responses bypass
 * the browser cache; successful business responses are validated against shared contracts.
 */
export function createStaffApi(
  fetcher: typeof fetch = fetch,
  activity: Pick<typeof staffActivity, 'consume'> = staffActivity,
  activityScope: string | (() => string) = 'default',
) {
  async function request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const active =
      path !== 'config' &&
      !path.startsWith('auth/') &&
      activity.consume(
        typeof activityScope === 'string' ? activityScope : activityScope(),
      );
    let response: Response;
    try {
      response = await fetcher(
        path.startsWith('auth/') ? `/api/${path}` : `/api/v1/staff/${path}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            ...(active ? { 'x-luma-staff-activity': 'true' } : {}),
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          ...(signal ? { signal } : {}),
          ...(body === undefined
            ? {}
            : {
                body: JSON.stringify(body),
              }),
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError')
        throw error;
      throw new StaffApiError(
        'The staff service is unavailable. Check your connection and try again.',
        0,
      );
    }
    if (!response.ok)
      throw new StaffApiError(
        (response.status === 409 ? await conflictMessage(response) : null) ??
          failureMessage(response.status, path),
        response.status,
      );
    try {
      return await response.json();
    } catch {
      throw new StaffApiError(
        'The staff service returned an unreadable response.',
        response.status,
      );
    }
  }

  const workspace = (id: string) => `workspaces/${encodeURIComponent(id)}`;
  const account = (id: string) => `accounts/${encodeURIComponent(id)}`;

  return {
    config: async (signal?: AbortSignal) =>
      staffConfigSchema.parse(await request('config', undefined, signal)),
    session: async (signal?: AbortSignal) =>
      staffSessionSchema.parse(await request('session', undefined, signal)),
    directory: async (query: string, signal?: AbortSignal) =>
      staffDirectorySchema.parse(
        await request(
          `directory?${new URLSearchParams({ query })}`,
          undefined,
          signal,
        ),
      ),
    placement: async (workspaceId: string, signal?: AbortSignal) =>
      staffWorkspacePlacementSchema.parse(
        await request(`${workspace(workspaceId)}/placement`, undefined, signal),
      ),
    grant: async (workspaceId: string, reason: string) =>
      staffAccessGrantSchema.parse(
        await request(`${workspace(workspaceId)}/access`, { reason }),
      ),
    workspace: async (
      workspaceId: string,
      grantId: string,
      signal?: AbortSignal,
    ) =>
      staffWorkspaceDetailSchema.parse(
        await request(
          `${workspace(workspaceId)}?${new URLSearchParams({ grantId })}`,
          undefined,
          signal,
        ),
      ),
    health: async (
      workspaceId: string,
      grantId: string,
      signal?: AbortSignal,
    ) =>
      staffWorkspaceHealthSchema.parse(
        await request(
          `${workspace(workspaceId)}/health?${new URLSearchParams({ grantId })}`,
          undefined,
          signal,
        ),
      ),
    accessHistory: async (
      workspaceId: string,
      grantId: string,
      cursor: string | null,
      signal?: AbortSignal,
    ) =>
      staffAccessHistorySchema.parse(
        await request(
          `${workspace(workspaceId)}/access-history?${new URLSearchParams({
            grantId,
            ...(cursor ? { cursor } : {}),
          })}`,
          undefined,
          signal,
        ),
      ),
    audit: async (
      filters: {
        staff?: string | undefined;
        workspace?: string | undefined;
        account?: string | undefined;
        event?: string | undefined;
        from?: string | undefined;
        to?: string | undefined;
      },
      cursor: string | null,
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries({ ...filters, cursor }))
        if (value) query.set(key, value);

      return staffAuditPageSchema.parse(
        await request(`audit?${query}`, undefined, signal),
      );
    },
    revokeSessions: async (
      workspaceId: string,
      userId: string,
      body: {
        grantId: string;
        reason: string;
        commandId: string;
        acknowledgeGlobalEffect: true;
      },
    ) =>
      staffRevokeSessionsResultSchema.parse(
        await request(
          `${workspace(workspaceId)}/users/${encodeURIComponent(userId)}/revoke-sessions`,
          body,
        ),
      ),
    changeMembership: async (
      workspaceId: string,
      userId: string,
      action: 'suspend' | 'reactivate',
      body: {
        grantId: string;
        reason: string;
        commandId: string;
        acknowledgeLastOwner?: boolean;
      },
    ) =>
      staffMembershipChangeSchema.parse(
        await request(
          `${workspace(workspaceId)}/users/${encodeURIComponent(userId)}/${action}-membership`,
          body,
        ),
      ),
    startSupportView: async (
      workspaceId: string,
      userId: string,
      body: { grantId: string; reason: string } & (
        | { mode: 'consent' }
        | {
            mode: 'emergency';
            category: 'security_incident' | 'legal_request';
            reference: string;
          }
      ),
    ) =>
      staffSupportViewSchema.parse(
        await request(
          `${workspace(workspaceId)}/users/${encodeURIComponent(userId)}/support-view`,
          body,
        ),
      ),
    requestSupportAccess: async (
      workspaceId: string,
      body: { grantId: string; reason: string; durationHours: 24 | 72 | 168 },
    ) =>
      staffSupportAccessRequestSchema.parse(
        await request(
          `${workspace(workspaceId)}/support-access-requests`,
          body,
        ),
      ),
    changeAccount: async (
      userId: string,
      body: { grantId: string; reason: string; commandId: string } & (
        | {
            action: 'disable';
            category: z.infer<typeof staffAccountDisableCategorySchema>;
          }
        | { action: 'enable' }
      ),
    ) => {
      const { action, ...rest } = body;

      return staffAccountChangeSchema.parse(
        await request(
          `${account(userId)}/${action}`,
          action === 'disable'
            ? { ...rest, acknowledgeGlobalEffect: true }
            : rest,
        ),
      );
    },
    /** Schedules, restores or immediately erases an account; retries reuse the command ID. */
    changeAccountDeletion: async (
      userId: string,
      body: { grantId: string; reason: string; commandId: string } & (
        | {
            action: 'schedule';
            category: z.infer<typeof staffAccountDeletionCategorySchema>;
            reference: string;
          }
        | { action: 'restore' }
        | { action: 'erase_now'; reference: string }
      ),
    ) => {
      const { action, ...rest } = body;

      return staffAccountDeletionChangeSchema.parse(
        await request(
          `${account(userId)}/${action === 'schedule' ? 'deletion' : action === 'restore' ? 'restore' : 'erasure'}`,
          action === 'schedule'
            ? { ...rest, acknowledgeGlobalEffect: true }
            : action === 'erase_now'
              ? { ...rest, acknowledgePermanent: true }
              : rest,
        ),
      );
    },
    grantAccount: async (userId: string, reason: string) =>
      staffAccountAccessSchema.parse(
        await request(`${account(userId)}/access`, { reason }),
      ),
    account: async (userId: string, grantId: string, signal?: AbortSignal) =>
      staffAccountDetailSchema.parse(
        await request(
          `${account(userId)}?${new URLSearchParams({ grantId })}`,
          undefined,
          signal,
        ),
      ),
    accountSecurityEvents: async (
      userId: string,
      grantId: string,
      cursor: string | undefined,
      signal?: AbortSignal,
    ) =>
      staffAccountSecurityEventsSchema.parse(
        await request(
          `${account(userId)}/security-events?${new URLSearchParams({
            grantId,
            ...(cursor ? { cursor } : {}),
          })}`,
          undefined,
          signal,
        ),
      ),
    signIn: (email: string, password: string) =>
      request('auth/sign-in/email', { email, password }),
    signOut: () => request('auth/sign-out', {}),
    google: async () => {
      const response = await request('auth/sign-in/social', {
        provider: 'google',
        callbackURL: `${window.location.origin}${staffPath('/')}`,
        errorCallbackURL: `${window.location.origin}${staffPath('/login?signInFailed=true')}`,
      });
      if (
        !response ||
        typeof response !== 'object' ||
        !('url' in response) ||
        typeof response.url !== 'string'
      )
        throw new StaffApiError(
          'Google sign-in could not be started. Try again.',
          0,
        );
      const url = new URL(response.url);
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com')
        throw new StaffApiError(
          'Google sign-in returned an unexpected destination.',
          0,
        );
      window.location.assign(url.href);
    },
  };
}

/** Binds private requests to one region for the lifetime of the caller's query or command. */
export function staffApiForRegion(region: StaffRegion = staffRegion()) {
  return createStaffApi(regionalFetch(region), staffActivity, region);
}

/** Uses the rendered route's owning region even while a different regional navigation is pending. */
export function useRegionalStaffApi() {
  const region = useSearch({
    strict: false,
    select: (search) => search.region,
  });

  return staffApiForRegion(region ?? staffRegion());
}
