import { ConnectorError } from '@luma/connector-core';
import { describe, expect, it, vi } from 'vitest';

import { createClient, gmailFailure } from './client.js';
import {
  authorizationUrl,
  codeChallenge,
  createOAuthClient,
  gmailScopes,
} from './oauth.js';
import { createQuotaPacer } from './pacer.js';

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => new Response(JSON.stringify(body), { status, headers });

const googleError = (code: number, reason: string) => ({
  error: { code, errors: [{ reason, message: 'private provider text' }] },
});

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectorError) return error.failure;
    throw error;
  }
  throw new Error('Expected a failure');
};

const noRetry = { attempts: 1, maxDelayMs: 0, sleep: async () => {} };

describe('gmailFailure', () => {
  it.each([
    [401, 'authError', null, 'authentication', undefined],
    [403, 'insufficientPermissions', null, 'permission_denied', undefined],
    [403, 'userRateLimitExceeded', null, 'rate_limited', 1000],
    [403, 'dailyLimitExceeded', null, 'rate_limited', 3_600_000],
    [429, 'rateLimitExceeded', '7', 'rate_limited', 7000],
    [404, 'notFound', null, 'not_found', undefined],
    [400, 'invalidArgument', null, 'invalid_input', undefined],
    [503, 'backendError', null, 'unavailable', 1000],
  ] as const)(
    'maps %i %s to %s',
    (status, reason, retryAfter, code, retryAfterMs) => {
      const { failure } = gmailFailure(
        status,
        googleError(status, reason),
        retryAfter,
      );
      expect(failure).toEqual({
        code,
        effect: 'none',
        retry: retryAfterMs === undefined ? 'never' : 'after_delay',
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    },
  );

  it('treats server errors after a send as uncertain', () => {
    expect(gmailFailure(500, null, null, true).failure).toMatchObject({
      code: 'unavailable',
      effect: 'unknown',
      retry: 'reconcile',
    });
    expect(gmailFailure(400, null, null, true).failure.effect).toBe('none');
  });
});

describe('createClient', () => {
  it('authenticates reads, retries short transient failures and discards provider text', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(503, googleError(503, 'backendError')))
      .mockResolvedValueOnce(
        json(200, { emailAddress: 'ops@shop.example', historyId: '1' }),
      );
    const client = createClient({
      accessToken: async () => 'token-1',
      fetch,
      readRetry: { attempts: 3, maxDelayMs: 2000, sleep: async () => {} },
    });
    await expect(client.profile()).resolves.toMatchObject({
      emailAddress: 'ops@shop.example',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer token-1',
    );
    expect(init?.redirect).toBe('error');
  });

  it('lists with the query and page token', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(200, { messages: [{ id: 'a', threadId: 'b' }] }));
    const client = createClient({ accessToken: async () => 't', fetch });
    await client.listMessages({
      q: 'from:(a.example)',
      pageToken: 'P',
      maxResults: 100,
    });
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.searchParams.get('q')).toBe('from:(a.example)');
    expect(url.searchParams.get('pageToken')).toBe('P');
    expect(url.searchParams.get('maxResults')).toBe('100');
  });

  it('sends once and reports a lost response as uncertain', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError('socket closed'));
    const client = createClient({
      accessToken: async () => 't',
      fetch,
      readRetry: noRetry,
    });
    expect(await failureOf(client.sendMessage('raw', 'thread'))).toMatchObject({
      code: 'transient',
      effect: 'unknown',
      retry: 'reconcile',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
      raw: 'raw',
      threadId: 'thread',
    });
  });

  it('rejects unsafe IDs before any request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createClient({ accessToken: async () => 't', fetch });
    await expect(client.getMessage('../profile')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('createQuotaPacer', () => {
  it('spaces admissions by quota cost', async () => {
    let clock = 0;
    const waits: number[] = [];
    const pacer = createQuotaPacer({
      unitsPerSecond: 100,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await pacer.run(5, async () => {});
    await pacer.run(100, async () => {});
    await pacer.run(1, async () => {});
    expect(waits).toEqual([50, 1000]);
  });
});

describe('Google OAuth', () => {
  const config = {
    clientId: 'client',
    clientSecret: 'secret',
    callbackUrl: 'https://luma.example/api/v1/gmail/callback',
  };

  it('requests offline access with PKCE and the Gmail scopes', () => {
    const url = new URL(
      authorizationUrl(config, {
        state: 'state',
        codeVerifier: 'verifier',
        loginHint: 'ops@shop.example',
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client',
      redirect_uri: config.callbackUrl,
      response_type: 'code',
      scope: gmailScopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: 'state',
      code_challenge: codeChallenge('verifier'),
      code_challenge_method: 'S256',
      login_hint: 'ops@shop.example',
    });
  });

  it('exchanges a code and reads the verified email address', async () => {
    const idToken = [
      'e30',
      Buffer.from(
        JSON.stringify({ email: 'Ops@Shop.example', email_verified: true }),
      ).toString('base64url'),
      'sig',
    ].join('.');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json(200, {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3599,
        scope: 'openid https://www.googleapis.com/auth/gmail.readonly',
        id_token: idToken,
      }),
    );
    const client = createOAuthClient(
      config,
      fetch,
      () => new Date('2026-10-01T00:00:00Z'),
    );
    await expect(
      client.token({ code: 'code', codeVerifier: 'verifier' }),
    ).resolves.toEqual({
      token: 'access',
      refreshToken: 'refresh',
      expiresAt: '2026-10-01T00:59:59.000Z',
      scopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
      emailAddress: 'ops@shop.example',
    });
    const body = new URLSearchParams(String(fetch.mock.calls[0]![1]?.body));
    expect(body.get('code_verifier')).toBe('verifier');
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it('maps invalid_grant to authentication and client errors to unavailable', async () => {
    const client = (status: number, error: string) =>
      createOAuthClient(config, async () => json(status, { error })).token({
        refreshToken: 'refresh',
      });
    expect((await failureOf(client(400, 'invalid_grant'))).code).toBe(
      'authentication',
    );
    expect((await failureOf(client(401, 'invalid_client'))).code).toBe(
      'unavailable',
    );
    expect(await failureOf(client(503, 'server'))).toMatchObject({
      code: 'transient',
      retry: 'after_delay',
    });
  });
});
