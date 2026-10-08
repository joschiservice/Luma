import {
  staffAccessGrantSchema,
  staffConfigSchema,
  staffDirectorySchema,
  staffRevokeSessionsResultSchema,
  staffSessionSchema,
  staffWorkspaceDetailSchema,
} from '@luma/api-contract/staff';

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

/**
 * Creates the same-origin staff API client. Cookies stay HTTP-only and all responses bypass
 * the browser cache; successful business responses are validated against shared contracts.
 */
export function createStaffApi(fetcher: typeof fetch = fetch) {
  async function request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(
        path.startsWith('auth/') ? `/api/${path}` : `/api/v1/staff/${path}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          ...(signal ? { signal } : {}),
          ...(body === undefined
            ? {}
            : {
                headers: { 'content-type': 'application/json' },
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
    signIn: (email: string, password: string) =>
      request('auth/sign-in/email', { email, password }),
    signOut: () => request('auth/sign-out', {}),
    google: async () => {
      const response = await request('auth/sign-in/social', {
        provider: 'google',
        callbackURL: `${window.location.origin}/`,
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

export const staffApi = createStaffApi();
