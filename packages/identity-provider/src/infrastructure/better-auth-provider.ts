import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { genericOAuth } from 'better-auth/plugins';
import { decodeJwt } from 'jose';

import type {
  GoogleWorkspaceAuthSettings,
  OidcAuthSettings,
} from '../application/provider-settings.js';
import { readExternalIdentity } from '../domain/external-identity.js';

function requireHttps(value: string): void {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(
      'Identity provider URLs must use HTTPS without credentials or fragments.',
    );
  }
}

/**
 * Builds a server-only Better Auth OIDC adapter with PKCE, nonce and verified ID tokens.
 * The caller supplies trusted discovery configuration and an explicit issuer/subject
 * authorization check, and disables account linking in its Better Auth instance.
 * Rejects missing/unverified email, unexpected issuer, denied bindings and missing ID tokens.
 * The adapter creates no workspace memberships or access grants.
 */
export function createOidcAuthPlugin(
  settings: OidcAuthSettings,
): BetterAuthPlugin {
  requireHttps(settings.discoveryUrl);
  requireHttps(settings.expectedIssuer);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(settings.providerId)) {
    throw new Error(
      'Identity provider ID must be a stable route-safe identifier.',
    );
  }
  if (!settings.clientId.trim() || !settings.clientSecret.trim()) {
    throw new Error('Identity provider client credentials are required.');
  }
  if (
    settings.hostedDomain !== undefined &&
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(
      settings.hostedDomain,
    )
  ) {
    throw new Error(
      'Identity provider hosted domain must be an exact lowercase domain.',
    );
  }

  const plugin = genericOAuth({
    config: [
      {
        providerId: settings.providerId,
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        discoveryUrl: settings.discoveryUrl,
        requireIdTokenVerification: true,
        disableIdTokenNonceBinding: false,
        pkce: true,
        scopes: ['openid', 'email', 'profile'],
        responseType: 'code',
        responseMode: 'query',
        disableProviderLogout: true,
        ...(settings.hostedDomain
          ? { authorizationUrlParams: { hd: settings.hostedDomain } }
          : {}),
        // The discovery adapter cryptographically verifies this token before calling us.
        // Requiring it prevents a missing-token response from falling back to userinfo.
        getUserInfo: async (tokens) => {
          if (!tokens.idToken) return null;
          const claims = decodeJwt(tokens.idToken);
          const identity = readExternalIdentity(
            claims,
            settings.expectedIssuer,
            settings.hostedDomain,
          );
          if (!identity || !(await settings.validateIdentity(identity)))
            return null;

          return {
            sub: identity.subject,
            iss: identity.issuer,
            email: identity.email,
            emailVerified: true,
            name: identity.name,
            ...(identity.hostedDomain ? { hd: identity.hostedDomain } : {}),
          };
        },
      },
    ],
  });

  return {
    ...plugin,
    hooks: {
      before: [
        {
          matcher: (context) => context.path === '/sign-in/social',
          handler: createAuthMiddleware(async (context) => {
            if (
              context.body?.provider === settings.providerId &&
              context.body?.idToken
            ) {
              throw new APIError('BAD_REQUEST', {
                message:
                  'This identity provider requires the redirect sign-in flow.',
              });
            }
          }),
        },
      ],
    },
    init: async (context) => {
      if (context.options.account?.accountLinking?.enabled !== false) {
        throw new Error(
          'Federated identity requires automatic account linking to be disabled.',
        );
      }
      if (
        context.oauthConfig.storeStateStrategy !== 'database' ||
        context.oauthConfig.skipStateCookieCheck
      ) {
        throw new Error(
          'Federated identity requires database OAuth state bound to the browser.',
        );
      }
      const initialized = await plugin.init(context);
      for (const provider of initialized.context.socialProviders) {
        if (provider.id !== settings.providerId) continue;
        if (provider.issuer !== settings.expectedIssuer) {
          throw new Error(
            'Identity provider discovery returned an unexpected issuer.',
          );
        }
        // Staff and customer federation use the server-bound redirect flow only.
        const getUserInfo = provider.getUserInfo;
        provider.getUserInfo = (tokens) => {
          if (!tokens.expectedIdTokenNonce) return Promise.resolve(null);

          return getUserInfo(tokens);
        };
      }

      return initialized;
    },
  };
}

/**
 * Restricts Google login to verified identities in the configured Workspace hosted domain.
 * Uses Google's fixed discovery endpoint; the caller must authorize each immutable subject.
 */
export function createGoogleWorkspaceAuthPlugin(
  settings: GoogleWorkspaceAuthSettings,
): BetterAuthPlugin {
  return createOidcAuthPlugin({
    ...settings,
    providerId: 'google',
    expectedIssuer: 'https://accounts.google.com',
    discoveryUrl:
      'https://accounts.google.com/.well-known/openid-configuration',
  });
}
