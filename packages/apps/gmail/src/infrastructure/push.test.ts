import type { TenantDatabase } from '@luma/platform';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  SignJWT,
} from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { GmailConfig } from '../config.js';
import { createPushIntake, createPushVerifier } from './push.js';

const push = {
  topic: 'projects/luma-test/topics/gmail',
  audience: 'https://luma.example/api/v1/gmail/push',
  serviceAccount: 'push@luma-test.iam.gserviceaccount.com',
};
const config: GmailConfig = {
  clientId: 'client',
  clientSecret: 'secret',
  environment: 'test',
  callbackUrl: 'https://luma.example/api/v1/gmail/callback',
  webOrigin: 'https://luma.example',
  push,
};

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let privateKey: PrivateKey;
let keys: ReturnType<typeof createLocalJWKSet>;
let otherKey: PrivateKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  keys = createLocalJWKSet({ keys: [jwk] });
  otherKey = (await generateKeyPair('RS256')).privateKey;
});

const sign = (claims: JWTPayload = {}, key = privateKey) => {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    iss: 'https://accounts.google.com',
    aud: push.audience,
    iat: now,
    exp: now + 300,
    email: push.serviceAccount,
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .sign(key);
};

describe('createPushVerifier', () => {
  it('accepts a Google-signed token for the configured audience and account', async () => {
    const verify = createPushVerifier(push, keys);
    expect(await verify(`Bearer ${await sign()}`)).toBe(true);
    expect(
      await verify(`Bearer ${await sign({ iss: 'accounts.google.com' })}`),
    ).toBe(true);
  });

  it.each([
    ['another audience', { aud: 'https://evil.example' }],
    ['another issuer', { iss: 'https://evil.example' }],
    ['another account', { email: 'someone@evil.example' }],
    ['an unverified email', { email_verified: false }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 60 }],
  ])('rejects %s', async (_name, claims) => {
    const verify = createPushVerifier(push, keys);
    expect(await verify(`Bearer ${await sign(claims)}`)).toBe(false);
  });

  it('rejects other signers and malformed headers', async () => {
    const verify = createPushVerifier(push, keys);
    expect(await verify(`Bearer ${await sign({}, otherKey)}`)).toBe(false);
    expect(await verify(undefined)).toBe(false);
    expect(await verify(`Basic ${await sign()}`)).toBe(false);
  });
});

describe('createPushIntake', () => {
  function database() {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const db: TenantDatabase = {
      transaction: async (_tenant, operation) => operation({ query }),
    };

    return { db, query };
  }

  const body = (data: unknown) => ({
    message: {
      data: Buffer.from(JSON.stringify(data)).toString('base64'),
      messageId: '1',
    },
    subscription: 'projects/luma-test/subscriptions/gmail',
  });

  it('wakes the bound mailbox for a verified notification', async () => {
    const { db, query } = database();
    const intake = createPushIntake(db, config, createPushVerifier(push, keys));
    await intake(
      `Bearer ${await sign()}`,
      body({ emailAddress: 'Ops@Shop.example', historyId: 12345 }),
    );
    expect(query).toHaveBeenCalledWith(
      'SELECT gmail_push_hint($1::text,$2::text,$3::text)',
      ['test:client', 'ops@shop.example', '12345'],
    );
  });

  it('acknowledges malformed notifications without waking anything', async () => {
    const { db, query } = database();
    const intake = createPushIntake(db, config, createPushVerifier(push, keys));
    await intake(`Bearer ${await sign()}`, { message: { data: '!!!' } });
    await intake(`Bearer ${await sign()}`, body({ historyId: 1 }));
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unverified requests and reports missing configuration', async () => {
    const { db, query } = database();
    await expect(
      createPushIntake(
        db,
        config,
        createPushVerifier(push, keys),
      )(
        'Bearer nope',
        body({ emailAddress: 'ops@shop.example', historyId: 1 }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      createPushIntake(db, { ...config, push: undefined })(undefined, {}),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(query).not.toHaveBeenCalled();
  });
});
