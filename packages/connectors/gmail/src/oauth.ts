import { createHash } from 'node:crypto';

import { ConnectorError } from '@luma/connector-core';
import { z } from 'zod';

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const readScope = 'https://www.googleapis.com/auth/gmail.readonly';

export const sendScope = 'https://www.googleapis.com/auth/gmail.send';

/** Scopes Luma requests: identity, read-only mailbox access and sending. */
export const gmailScopes = ['openid', 'email', readScope, sendScope] as const;

/** Broader scopes that also cover reading, as Google may report previously granted access. */
const readScopes = new Set([
  readScope,
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
]);

/** Broader scopes that also cover sending. */
const sendScopes = new Set([
  sendScope,
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
]);

/** Whether granted scopes allow reading messages. */
export const canRead = (scopes: readonly string[]) =>
  scopes.some((scope) => readScopes.has(scope));

/** Whether granted scopes allow sending messages. */
export const canSend = (scopes: readonly string[]) =>
  scopes.some((scope) => sendScopes.has(scope));

/** Credentials required to exchange or refresh Google tokens. */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

/** Google OAuth credentials with the granted scopes and the authorized account. */
export interface OAuthCredentials {
  token: string;
  /** Present on code exchange; refreshes keep the stored refresh token unless Google rotates it. */
  refreshToken: string | null;
  expiresAt: string;
  scopes: string[];
  /** Verified email address from the ID token, when Google returned one. */
  emailAddress: string | null;
}

/** Derives the PKCE S256 code challenge for a verifier. */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Builds the Google authorization URL for offline access with PKCE. `loginHint` preselects the
 * account; Google still lets the person choose another one.
 */
export function authorizationUrl(
  config: Pick<OAuthConfig, 'clientId' | 'callbackUrl'>,
  request: {
    state: string;
    codeVerifier: string;
    loginHint?: string | undefined;
  },
): string {
  const url = new URL(AUTHORIZATION_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    response_type: 'code',
    scope: gmailScopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: request.state,
    code_challenge: codeChallenge(request.codeVerifier),
    code_challenge_method: 'S256',
    ...(request.loginHint ? { login_hint: request.loginHint } : {}),
  }).toString();

  return url.href;
}

const tokenResponse = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096).optional(),
  expires_in: z.number().int().positive().max(31536000),
  scope: z.string().max(4096),
  id_token: z.string().max(16384).optional(),
});

const idClaims = z.object({
  email: z.string().min(3).max(320),
  email_verified: z.union([z.boolean(), z.literal('true')]),
});

/**
 * Reads the email claim of an ID token received directly from Google's token endpoint over
 * TLS, which OpenID Connect allows without verifying its signature. Unverified addresses are
 * ignored.
 */
function emailOf(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = idClaims.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );

    return claims.success && claims.data.email_verified !== false
      ? claims.data.email.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

const failure = (
  code: 'authentication' | 'unavailable' | 'transient',
  retryAfterMs?: number,
) =>
  new ConnectorError({
    code,
    effect: 'none',
    retry: retryAfterMs === undefined ? 'never' : 'after_delay',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

/**
 * Creates code-exchange, refresh and revocation requests against Google's OAuth endpoints.
 * A rejected grant (`invalid_grant`: revoked, expired or reused) fails with `authentication`;
 * client configuration errors fail with `unavailable` so stored credentials are kept.
 */
export function createOAuthClient(
  config: OAuthConfig,
  transport: typeof globalThis.fetch = globalThis.fetch,
  now = () => new Date(),
) {
  async function post(url: string, body: Record<string, string>) {
    try {
      return await transport(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(body).toString(),
      });
    } catch {
      throw failure('transient', 1000);
    }
  }

  return {
    /** Exchanges an authorization code or refresh token for an access token. */
    async token(
      grant: { code: string; codeVerifier: string } | { refreshToken: string },
    ): Promise<OAuthCredentials> {
      const response = await post(TOKEN_URL, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...('code' in grant
          ? {
              grant_type: 'authorization_code',
              code: grant.code,
              code_verifier: grant.codeVerifier,
              redirect_uri: config.callbackUrl,
            }
          : { grant_type: 'refresh_token', refresh_token: grant.refreshToken }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = z.object({ error: z.string() }).safeParse(body);
        if (error.success && error.data.error === 'invalid_grant')
          throw failure('authentication');
        if (response.status >= 500 || response.status === 429)
          throw failure('transient', 1000);
        throw failure('unavailable');
      }
      const result = tokenResponse.safeParse(body);
      if (!result.success) throw failure('transient');
      const value = result.data;

      return {
        token: value.access_token,
        refreshToken: value.refresh_token ?? null,
        expiresAt: new Date(
          now().getTime() + value.expires_in * 1000,
        ).toISOString(),
        scopes: value.scope.split(/\s+/).filter(Boolean),
        emailAddress: emailOf(value.id_token),
      };
    },
    /**
     * Revokes a refresh or access token at Google, which also ends the grant. Tokens Google no
     * longer knows count as revoked.
     */
    async revoke(token: string): Promise<void> {
      const response = await post(REVOKE_URL, { token });
      if (response.ok || response.status === 400) return;
      throw failure('transient', 1000);
    },
  };
}
