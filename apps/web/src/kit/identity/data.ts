import { passkeyClient } from '@better-auth/passkey/client';
import { m } from '@luma/i18n/messages';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { createAuthClient } from 'better-auth/client';
import {
  inferAdditionalFields,
  twoFactorClient,
} from 'better-auth/client/plugins';
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
  plugins: [
    twoFactorClient(),
    passkeyClient(),
    inferAdditionalFields({
      user: { dataRegion: { type: 'string', required: false, input: true } },
    }),
  ],
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

// Set when a Luma support view this tab held ended, so the next sign-in redirect explains it.
const supportViewEndedKey = 'luma.supportViewEnded';

/** Returns, and forgets, why a support view in this tab ended since the last check. */
export function takeEndedSupportView() {
  const reason = sessionStorage.getItem(supportViewEndedKey);
  sessionStorage.removeItem(supportViewEndedKey);

  return reason;
}

/** Reports whether this tab's support view ended and the next page should say so. */
export function supportViewJustEnded() {
  return sessionStorage.getItem(supportViewEndedKey) !== null;
}

/** Remembers that this tab's support view ended, for the page shown next. */
export function rememberEndedSupportView(reason: string) {
  sessionStorage.setItem(supportViewEndedKey, reason);
}

/**
 * Reads the current session without retaining unused private data; returns null when signed
 * out. A Luma support view takes precedence over a customer session, as on the server, and
 * presents the viewed member as the signed-in person.
 */
export const sessionOptions = () =>
  queryOptions({
    ...privateOptions,
    queryKey: sessionKey,
    queryFn: async ({ signal }) => {
      const view = await api.identity.supportView(undefined, { signal });
      if (view.active)
        return {
          sessionId: `support-view:${view.id}`,
          user: { ...view.member, twoFactorEnabled: false },
          supportView: view,
        };
      if (view.endReason) rememberEndedSupportView(view.endReason);
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
            supportView: null,
          }
        : null;
    },
  });

/** Opens the support view a staff console link's single-use token names. */
export function redeemSupportView(token: string) {
  return api.identity.redeemSupportView({ body: { token } });
}

/** Ends this browser's support view and clears its cookie. */
export function endSupportView() {
  return api.identity.endSupportView();
}

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
 * Creates a workspace in this cell with a validated name and generated slug; rejects unsuccessful API
 * responses.
 */
export async function createOrganization(name: string, dataRegion: DataRegion) {
  return api.identity.createOrganization({
    body: {
      name: workspaceName.parse(name),
      slug: organizationSlug(name),
      dataRegion,
    },
  });
}

/** Regions supported by Luma, including cells not yet available for sign-up. */
export const dataRegions = ['AU', 'EU', 'US'] as const;

export type DataRegion = (typeof dataRegions)[number];
const regionConfigSchema = z.object({
  region: z.enum(dataRegions),
  enabledRegions: z.array(z.enum(dataRegions)),
  regionalOrigins: z.partialRecord(z.enum(dataRegions), z.url()),
});

/** Reads the cell's public placement settings, failing closed when the service is unavailable. */
export const regionOptions = () =>
  queryOptions({
    queryKey: ['public', 'region-config'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/auth/region-config', {
        signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new IdentityError(response.status);

      return regionConfigSchema.parse(await response.json());
    },
    retry: false,
    staleTime: 0,
  });

/** Creates an account only after an explicit region confirmation. */
export function signUpInRegion(
  value: { name: string; email: string; password: string },
  dataRegion: DataRegion,
) {
  return auth.signUp.email({ ...value, dataRegion });
}
