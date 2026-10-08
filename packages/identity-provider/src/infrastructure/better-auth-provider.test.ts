import { betterAuth } from 'better-auth';
import type { OAuthProvider } from 'better-auth/oauth2';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { VerifiedExternalIdentity } from '../domain/external-identity.js';
import {
  createGoogleWorkspaceAuthPlugin,
  createOidcAuthPlugin,
} from './better-auth-provider.js';

const issuer = 'https://accounts.google.com';
const clientId = 'staff-client';
const nonce = 'server-generated-nonce';
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: 'test-key',
    alg: 'RS256',
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function signToken(claims: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: 'immutable-google-subject',
    email: 'Operator@example.com',
    email_verified: true,
    hd: 'example.com',
    name: 'Operator',
    nonce,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(typeof claims.iss === 'string' ? claims.iss : issuer)
    .setAudience(typeof claims.aud === 'string' ? claims.aud : clientId)
    .setIssuedAt(typeof claims.iat === 'number' ? claims.iat : undefined)
    .setExpirationTime(typeof claims.exp === 'number' ? claims.exp : '5m')
    .sign(privateKey);
}

function mockDiscovery(
  discovery: Record<string, unknown> = {},
  exchange?: (body: URLSearchParams) => Promise<Response>,
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/keys`,
        id_token_signing_alg_values_supported: ['RS256'],
        ...discovery,
      });
    }
    if (url === `${issuer}/keys`) return Response.json({ keys: [publicJwk] });
    if (url === `${issuer}/token` && exchange) {
      return exchange(new URLSearchParams(String(options?.body)));
    }
    throw new Error(`Unexpected provider request: ${url}`);
  });
}

async function provider(
  validateIdentity = vi.fn<(identity: VerifiedExternalIdentity) => boolean>(
    () => true,
  ),
) {
  const auth = betterAuth({
    baseURL: 'http://localhost:3100',
    secret: 'development-test-secret-with-at-least-32-characters',
    account: {
      accountLinking: { enabled: false },
      storeStateStrategy: 'database',
    },
    plugins: [
      createGoogleWorkspaceAuthPlugin({
        clientId,
        clientSecret: 'server-secret',
        hostedDomain: 'example.com',
        validateIdentity,
      }),
    ],
  });
  const context = await auth.$context;
  const google: OAuthProvider | undefined = context.socialProviders.find(
    (item) => item.id === 'google',
  );

  return { auth, google, validateIdentity };
}

describe('verified identity provider adapter', () => {
  it('uses an exact hosted domain, PKCE and server-bound nonce for authorization', async () => {
    mockDiscovery();
    const { google } = await provider();
    expect(google?.requiresIdTokenNonce).toBe(true);
    const url = await google?.createAuthorizationURL({
      state: 'server-generated-state',
      codeVerifier: 'a'.repeat(64),
      idTokenNonce: nonce,
      redirectURI: 'http://localhost:3100/api/auth/callback/google',
    });

    expect(url?.searchParams.get('state')).toBe('server-generated-state');
    expect(url?.searchParams.get('nonce')).toBe(nonce);
    expect(url?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url?.searchParams.get('code_challenge')).toBeTruthy();
    expect(url?.searchParams.get('hd')).toBe('example.com');
    expect(url?.searchParams.get('response_type')).toBe('code');
  });

  it('passes the verified issuer and immutable subject to the explicit binding check', async () => {
    mockDiscovery();
    const { google, validateIdentity } = await provider();
    const result = await google?.getUserInfo({
      idToken: await signToken(),
      expectedIdTokenNonce: nonce,
    });

    expect(result?.user.emailVerified).toBe(true);
    expect(validateIdentity).toHaveBeenCalledExactlyOnceWith({
      issuer,
      subject: 'immutable-google-subject',
      email: 'operator@example.com',
      name: 'Operator',
      hostedDomain: 'example.com',
    });
  });

  it.each([
    ['wrong issuer', { iss: 'https://other.example.com' }],
    ['wrong audience', { aud: 'customer-client' }],
    ['wrong nonce', { nonce: 'attacker-nonce' }],
    ['missing nonce', { nonce: undefined }],
    ['expired token', { exp: 1 }],
    ['future issue time', { iat: Math.floor(Date.now() / 1000) + 3600 }],
    ['unverified email', { email_verified: false }],
    ['string verification claim', { email_verified: 'true' }],
    ['personal Google account', { hd: undefined }],
    ['wrong Workspace', { hd: 'other.example.com' }],
    ['missing subject', { sub: undefined }],
  ])('rejects %s before evaluating local authority', async (_label, claims) => {
    mockDiscovery();
    const { google, validateIdentity } = await provider();
    const result = await google?.getUserInfo({
      idToken: await signToken(claims),
      expectedIdTokenNonce: nonce,
    });

    expect(result).toBeNull();
    expect(validateIdentity).not.toHaveBeenCalled();
  });

  it('rejects a tampered token and missing token without falling back to userinfo', async () => {
    mockDiscovery();
    const { google, validateIdentity } = await provider();
    const token = await signToken();
    const [header, payload, signature] = token.split('.');
    const tamperedSignature = `${signature?.[0] === 'a' ? 'b' : 'a'}${signature?.slice(1)}`;
    expect(
      await google?.getUserInfo({
        idToken: `${header}.${payload}.${tamperedSignature}`,
        expectedIdTokenNonce: nonce,
      }),
    ).toBeNull();
    expect(
      await google?.getUserInfo({ accessToken: 'userinfo-only-token' }),
    ).toBeNull();
    expect(validateIdentity).not.toHaveBeenCalled();
  });

  it('rejects a cryptographically valid identity without an explicit local binding', async () => {
    mockDiscovery();
    const { google } = await provider(vi.fn(() => false));
    expect(
      await google?.getUserInfo({
        idToken: await signToken(),
        expectedIdTokenNonce: nonce,
      }),
    ).toBeNull();
  });

  it('requires a server-bound nonce and disables direct browser ID-token sign-in', async () => {
    mockDiscovery();
    const { auth, google, validateIdentity } = await provider();
    expect(
      await google?.getUserInfo({ idToken: await signToken() }),
    ).toBeNull();
    const response = await auth.handler(
      new Request('http://localhost:3100/api/auth/sign-in/social', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3100',
        },
        body: JSON.stringify({
          provider: 'google',
          idToken: { token: await signToken() },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(validateIdentity).not.toHaveBeenCalled();
  });

  it('fails closed when discovery does not supply verification metadata', async () => {
    mockDiscovery({ jwks_uri: undefined });
    const { google } = await provider();
    expect(google).toBeUndefined();
  });

  it('rejects discovery metadata for a different issuer', async () => {
    mockDiscovery({ issuer: 'https://other.example.com' });
    await expect(provider()).rejects.toThrow('unexpected issuer');
  });

  it('rejects a callback without a browser-bound OAuth state', async () => {
    mockDiscovery();
    const { auth, validateIdentity } = await provider();
    const response = await auth.handler(
      new Request(
        'http://localhost:3100/api/auth/callback/google?code=forged&state=forged',
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=');
    expect(validateIdentity).not.toHaveBeenCalled();
  });

  it('consumes browser-bound callback state once and exchanges the persisted PKCE verifier', async () => {
    const transaction: { authorization?: URL } = {};
    const exchange = vi.fn(async (body: URLSearchParams) => {
      expect(body.get('code')).toBe('provider-code');
      expect(body.get('code_verifier')).toBeTruthy();
      expect(body.get('client_id')).toBe(clientId);

      return Response.json({
        token_type: 'Bearer',
        access_token: 'provider-access-token',
        id_token: await signToken({
          nonce: transaction.authorization?.searchParams.get('nonce'),
        }),
      });
    });
    mockDiscovery({}, exchange);
    const { auth, validateIdentity } = await provider();
    const start = await auth.handler(
      new Request('http://localhost:3100/api/auth/sign-in/social', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3100',
        },
        body: JSON.stringify({
          provider: 'google',
          callbackURL: 'http://localhost:3100/',
        }),
      }),
    );
    const body: unknown = await start.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !('url' in body) ||
      typeof body.url !== 'string'
    ) {
      throw new Error('Authorization URL was not returned.');
    }
    const authorization = new URL(body.url);
    transaction.authorization = authorization;
    const cookie = start.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const callbackUrl = new URL(
      'http://localhost:3100/api/auth/callback/google',
    );
    callbackUrl.searchParams.set('code', 'provider-code');
    callbackUrl.searchParams.set(
      'state',
      authorization.searchParams.get('state') ?? '',
    );

    const first = await auth.handler(
      new Request(callbackUrl, { headers: { cookie } }),
    );
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('http://localhost:3100/');
    expect(validateIdentity).toHaveBeenCalledOnce();
    const replay = await auth.handler(
      new Request(callbackUrl, { headers: { cookie } }),
    );
    expect(replay.headers.get('location')).toContain('error=');
    expect(exchange).toHaveBeenCalledOnce();
  });

  it('rejects wildcard domains and non-HTTPS server discovery configuration', () => {
    expect(() =>
      createGoogleWorkspaceAuthPlugin({
        clientId,
        clientSecret: 'secret',
        hostedDomain: '*',
        validateIdentity: () => true,
      }),
    ).toThrow('exact lowercase domain');
    expect(() =>
      createOidcAuthPlugin({
        providerId: 'company',
        clientId,
        clientSecret: 'secret',
        expectedIssuer: issuer,
        discoveryUrl: 'http://untrusted.example.com/discovery',
        validateIdentity: () => true,
      }),
    ).toThrow('HTTPS');
  });
});
