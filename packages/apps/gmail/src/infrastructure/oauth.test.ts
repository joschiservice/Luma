import { createHash } from 'node:crypto';

import { secretBinding } from '@luma/connections';
import { readScope, sendScope } from '@luma/connector-gmail';
import type { TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import type { GmailConfig } from '../config.js';
import { createFakeDatabase, fakeCipher } from '../test-support/database.js';
import { createGmailOAuth } from './oauth.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const other = '33333333-3333-4333-8333-333333333333';
const config: GmailConfig = {
  clientId: 'client',
  clientSecret: 'secret',
  environment: 'test',
  callbackUrl: 'https://luma.example/api/v1/gmail/callback',
  webOrigin: 'https://luma.example',
};

const contextFor = (tenant = tenantId, session = 'session-1') =>
  ({
    tenantId: tenant,
    actor: { id: 'user-1', sessionId: session },
    requestId: 'request-1',
  }) as unknown as TenantContext;

const idToken = (email: string) =>
  [
    'e30',
    Buffer.from(JSON.stringify({ email, email_verified: true })).toString(
      'base64url',
    ),
    'sig',
  ].join('.');

function google(
  scopes = ['openid', 'email', readScope, sendScope],
  email = 'ops@shop.example',
) {
  const requests: URLSearchParams[] = [];
  const fetch = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      requests.push(body);

      return new Response(
        JSON.stringify({
          access_token: `access-${requests.length}`,
          ...(body.get('grant_type') === 'authorization_code'
            ? { refresh_token: 'refresh-1' }
            : {}),
          expires_in: 3600,
          scope: scopes.join(' '),
          id_token: idToken(email),
        }),
        { status: 200 },
      );
    },
  );

  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

function setup(
  fetch: typeof globalThis.fetch,
  now = new Date('2026-10-01T00:00:00Z'),
) {
  const db = createFakeDatabase();
  const verify = vi.fn(async () => [
    'messages.read' as const,
    'message-threads.read' as const,
    'message-attachments.read' as const,
    'messages.send' as const,
  ]);
  const oauth = createGmailOAuth(db.database, config, {
    cipher: fakeCipher,
    refreshContext: async (context) => context,
    verify,
    fetch,
    now: () => now,
    requireInstalled: async () => 1,
    authorize: async () => {},
  });

  return { db, oauth, verify };
}

async function authorize(
  oauth: ReturnType<typeof setup>['oauth'],
  context = contextFor(),
) {
  const { authorizationUrl } = await oauth.start(context, {
    label: 'Orders mailbox',
    loginHint: 'Ops@Shop.example',
  });
  const url = new URL(authorizationUrl);

  return { url, state: url.searchParams.get('state')! };
}

describe('Gmail authorization', () => {
  it('stores only a digest of the state and binds it to the session', async () => {
    const { db, oauth } = setup(google().fetch);
    const { url, state } = await authorize(oauth);
    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(url.searchParams.get('login_hint')).toBe('ops@shop.example');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(state.startsWith(`${tenantId}.`)).toBe(true);
    expect(db.states).toHaveLength(1);
    expect(db.states[0]).toMatchObject({
      digest: createHash('sha256').update(state).digest('hex'),
      actor: 'user-1',
      session: 'session-1',
      app: 'test:client:1',
    });
    expect(oauth.callbackTenant(`state=${state}&code=c`)).toBe(tenantId);
  });

  it('connects the mailbox with PKCE, sealed credentials and a mailbox binding', async () => {
    const google1 = google();
    const { db, oauth } = setup(google1.fetch);
    const { url, state } = await authorize(oauth);
    await expect(
      oauth.callback(contextFor(), `state=${state}&code=auth-code&scope=x`),
    ).resolves.toBe('connected');

    const exchange = google1.requests[0]!;
    expect(exchange.get('code')).toBe('auth-code');
    expect(
      createHash('sha256')
        .update(exchange.get('code_verifier')!)
        .digest('base64url'),
    ).toBe(url.searchParams.get('code_challenge'));

    const [row] = [...db.connections.values()];
    expect(row!.document).toMatchObject({
      target: { kind: 'gmail', emailAddress: 'ops@shop.example' },
      appId: 'gmail',
      provider: 'gmail',
      label: 'Orders mailbox',
      status: 'active',
      management: [],
      granted: [
        'messages.read',
        'message-threads.read',
        'message-attachments.read',
        'messages.send',
      ],
    });
    expect(fakeCipher.open(row!.secret!, secretBinding(row!.document))).toEqual(
      {
        token: 'access-1',
        gmail: {
          app: 'test:client',
          refreshToken: 'refresh-1',
          expiresAt: '2026-10-01T01:00:00.000Z',
          scopes: ['openid', 'email', readScope, sendScope],
          emailAddress: 'ops@shop.example',
        },
      },
    );
    expect(db.bindings).toEqual([
      {
        tenant: tenantId,
        app: 'test:client',
        email: 'ops@shop.example',
        id: row!.document.id,
      },
    ]);

    // State is single-use.
    await expect(
      oauth.callback(contextFor(), `state=${state}&code=auth-code`),
    ).rejects.toThrow('Connect again');
  });

  it('keeps a mailbox without send access active and read-only', async () => {
    const { db, oauth } = setup(google(['openid', 'email', readScope]).fetch);
    const { state } = await authorize(oauth);
    await expect(
      oauth.callback(contextFor(), `state=${state}&code=c`),
    ).resolves.toBe('connected');
    const [row] = [...db.connections.values()];
    expect(row!.document.status).toBe('active');
    expect(row!.document.granted).not.toContain('messages.send');
    expect(row!.document.permissions).toContain('messages.send');
    await expect(
      oauth.access(contextFor(), row!.document.id),
    ).resolves.toMatchObject({
      emailAddress: 'ops@shop.example',
      canRead: true,
      canSend: false,
      missingScopes: [sendScope],
    });
  });

  it('records a mailbox without read access as needing permissions', async () => {
    const { db, oauth, verify } = setup(google(['openid', 'email']).fetch);
    const { state } = await authorize(oauth);
    await expect(
      oauth.callback(contextFor(), `state=${state}&code=c`),
    ).resolves.toBe('permissions');
    expect(verify).not.toHaveBeenCalled();
    expect([...db.connections.values()][0]!.document).toMatchObject({
      status: 'degraded',
      granted: [],
    });
  });

  it('reports a denied consent and rejects another session or duplicate parameters', async () => {
    const { oauth } = setup(google().fetch);
    const first = await authorize(oauth);
    await expect(
      oauth.callback(
        contextFor(tenantId, 'session-2'),
        `state=${first.state}&code=c`,
      ),
    ).rejects.toThrow('Connect again');
    await expect(
      oauth.callback(contextFor(), `state=${first.state}&code=a&code=b`),
    ).rejects.toThrow('Connect again');
    await expect(
      oauth.callback(contextFor(), `state=${first.state}&error=access_denied`),
    ).resolves.toBe('denied');
  });

  it('refuses a mailbox another workspace already connected', async () => {
    const { db, oauth } = setup(google().fetch);
    db.bindings.push({
      tenant: other,
      app: 'test:client',
      email: 'ops@shop.example',
      id: '44444444-4444-4444-8444-444444444444',
    });
    const { state } = await authorize(oauth);
    await expect(
      oauth.callback(contextFor(), `state=${state}&code=c`),
    ).rejects.toThrow('already connected');
    expect(db.connections.size).toBe(0);
  });
});

describe('Gmail credential refresh', () => {
  async function connected(scopes?: string[]) {
    const google1 = google(scopes);
    const now = { value: new Date('2026-10-01T00:00:00Z') };
    const db = createFakeDatabase();
    const oauth = createGmailOAuth(db.database, config, {
      cipher: fakeCipher,
      refreshContext: async (context) => context,
      verify: async () => [
        'messages.read',
        'message-threads.read',
        'message-attachments.read',
        'messages.send',
      ],
      fetch: google1.fetch,
      now: () => now.value,
      requireInstalled: async () => 1,
      authorize: async () => {},
    });
    const { state } = await authorize(oauth);
    await oauth.callback(contextFor(), `state=${state}&code=c`);
    const id = [...db.connections.keys()][0]!;

    return { google: google1, db, oauth, id, now };
  }

  it('returns current tokens until they expire within a minute, then refreshes', async () => {
    const { google: g, db, oauth, id, now } = await connected();
    await expect(oauth.credential(contextFor(), id)).resolves.toMatchObject({
      token: 'access-1',
    });
    expect(g.requests).toHaveLength(1);

    now.value = new Date('2026-10-01T00:59:30Z');
    const refreshed = await oauth.credential(contextFor(), id);
    expect(refreshed).toMatchObject({
      token: 'access-2',
      gmail: {
        refreshToken: 'refresh-1',
        expiresAt: '2026-10-01T01:59:30.000Z',
      },
    });
    expect(g.requests[1]!.get('grant_type')).toBe('refresh_token');
    expect(db.connections.get(id)!.document).toMatchObject({
      status: 'active',
      credentialVersion: 2,
    });
    expect(db.events.at(-1)?.event).toBe('gmail_token_refreshed');
  });

  it('drops send access when a refresh no longer grants it', async () => {
    const { db, oauth, id, now, google: g } = await connected();
    (g.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'a',
          expires_in: 3600,
          scope: readScope,
        }),
      ),
    );
    now.value = new Date('2026-10-01T01:00:00Z');
    await oauth.credential(contextFor(), id);
    expect(db.connections.get(id)!.document.granted).toEqual([
      'messages.read',
      'message-threads.read',
      'message-attachments.read',
    ]);
  });

  it('revokes the connection when Google rejects the refresh token', async () => {
    const { db, oauth, id, now, google: g } = await connected();
    (g.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    now.value = new Date('2026-10-01T01:00:00Z');
    await expect(oauth.credential(contextFor(), id)).rejects.toMatchObject({
      failure: { code: 'authentication' },
    });
    expect(db.connections.get(id)).toMatchObject({
      secret: null,
      document: { status: 'revoked', granted: [] },
    });
  });

  it('keeps stored tokens when Google is temporarily unavailable', async () => {
    const { db, oauth, id, now, google: g } = await connected();
    (g.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('{}', { status: 503 }),
    );
    now.value = new Date('2026-10-01T01:00:00Z');
    await expect(oauth.credential(contextFor(), id)).rejects.toMatchObject({
      failure: { code: 'transient' },
    });
    expect(db.connections.get(id)!.document.status).toBe('active');
    expect(db.connections.get(id)!.secret).not.toBeNull();
  });
});
