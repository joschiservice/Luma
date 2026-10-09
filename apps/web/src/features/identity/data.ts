import { passkeyClient } from '@better-auth/passkey/client';
import { m } from '@luma/i18n/messages';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { createAuthClient } from 'better-auth/client';
import { twoFactorClient } from 'better-auth/client/plugins';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { IdentityError } from '../../lib/api-error';
import { privateQueryDefaults } from '../../lib/private-query';

export const auth = createAuthClient({
  basePath: '/api/auth',
  // Resolve fetch per request so previews and tests can intercept auth calls.
  fetchOptions: {
    retry: 0,
    customFetchImpl: (input, init) => globalThis.fetch(input, init),
  },
  plugins: [twoFactorClient(), passkeyClient()],
});

const api = createWebApiClient();

export const sessionKey = ['private', 'session'] as const;

const unchanging = () => () => undefined;

/** Reports whether this browser supports WebAuthn passkeys; false during server rendering. */
export function usePasskeySupport() {
  return useSyncExternalStore(
    unchanging,
    () => typeof window.PublicKeyCredential === 'function',
    () => false,
  );
}

export { IdentityError };

/**
 * Returns a local application path, falling back to /app for external, malformed, or
 * unsupported destinations.
 */
export function returnPath(value: unknown): string {
  if (typeof value !== 'string' || /[\\\s%]/.test(value)) return '/app';
  try {
    const url = new URL(value, 'https://luma.invalid');
    if (
      !value.startsWith('/') ||
      url.origin !== 'https://luma.invalid' ||
      !(url.pathname === '/app' || url.pathname.startsWith('/app/'))
    )
      return '/app';

    return url.pathname + url.search + url.hash;
  } catch {
    return '/app';
  }
}

export const authSearch = z.object({
  returnTo: z.unknown().optional().transform(returnPath),
});

export const workspaceName = z
  .string()
  .trim()
  .min(1, { error: () => m.identity_new_workspace_name_required() })
  .max(200, { error: () => m.identity_new_workspace_name_too_long() });

/** Builds a normalized workspace slug with a random suffix to reduce naming collisions. */
export function organizationSlug(name: string) {
  const stem =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 70)
      .replace(/-$/, '') || 'workspace';

  return `${stem}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Cancels and removes private queries, optionally limited to one organization. */
export async function clearPrivate(
  client: QueryClient,
  organizationId?: string,
) {
  const queryKey = organizationId
    ? ['private', 'organization', organizationId]
    : ['private'];
  await client.cancelQueries({ queryKey });
  client.removeQueries({ queryKey });
}

const privateOptions = {
  ...privateQueryDefaults,
  refetchOnMount: 'always',
  refetchOnWindowFocus: 'always',
} as const;

/**
 * Reads the current session without retaining unused private data; returns null when signed
 * out.
 */
export const sessionOptions = () =>
  queryOptions({
    ...privateOptions,
    queryKey: sessionKey,
    queryFn: async ({ signal }) => {
      const result = await auth.getSession({
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.error)
        throw new IdentityError(result.error.status, result.error);

      return result.data
        ? {
            sessionId: result.data.session.id,
            user: {
              id: result.data.user.id,
              name: result.data.user.name,
              email: result.data.user.email,
              twoFactorEnabled: result.data.user.twoFactorEnabled === true,
            },
          }
        : null;
    },
  });

/** Loads the current user's organizations with immediate staleness and no automatic retries. */
export const organizationsOptions = () =>
  queryOptions({
    ...privateOptions,
    queryKey: ['private', 'organizations'],
    queryFn: async ({ signal }) =>
      (await api.identity.listOrganizations(undefined, { signal })).items,
  });

/**
 * Loads the current tenant context for an organization; invalid IDs are reported as not
 * found.
 */
export const contextOptions = (organizationId: string) =>
  queryOptions({
    ...privateOptions,
    queryKey: ['private', 'organization', organizationId, 'context'],
    queryFn: async ({ signal }) => {
      if (!z.uuid().safeParse(organizationId).success)
        throw new IdentityError(404);

      return api.identity.context({ params: { organizationId } }, { signal });
    },
  });

/**
 * Creates an EU workspace with a validated name and generated slug; rejects unsuccessful API
 * responses.
 */
export async function createOrganization(name: string) {
  return api.identity.createOrganization({
    body: {
      name: workspaceName.parse(name),
      slug: organizationSlug(name),
      dataRegion: 'EU',
    },
  });
}
