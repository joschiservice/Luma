import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildRuntimeApp } from '@luma/application-runtime';
import { createIdentity } from '@luma/identity/composition';

import { addMembership, database, secret, verifyEmail } from './helpers.mjs';

export async function settingsFixture(
  t,
  origin = 'http://localhost:3000',
  {
    connections,
    observability,
    mailWebhookSecret,
    morningBriefEnabled,
    rateLimit = false,
  } = {},
) {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const messages = new Map();
  let fail = false;
  let beforeSend = async () => {};
  let failWith;
  const config = {
    databaseUrl: db.runtimeUrl,
    secret,
    baseURL: origin,
    trustedOrigins: [origin],
    // Fixtures sign in many times from one inject address; tests of limits turn them on.
    rateLimit: { enabled: rateLimit },
    mailOrigin: origin,
    ...(morningBriefEnabled ? { morningBriefEnabled } : {}),
    ...(mailWebhookSecret
      ? {
          mail: {
            apiKey: 're_test_key',
            from: 'Luma <notifications@example.test>',
            origin,
            webhookSecret: mailWebhookSecret,
          },
        }
      : {}),
    mailProvider: {
      async send(message) {
        await beforeSend();
        if (fail) throw new Error('Deterministic mail failure');
        if (failWith) throw failWith;
        messages.set(message.id, message);

        return { providerId: `provider-${message.id}` };
      },
    },
  };
  const identity = createIdentity(config, {
    onDatabaseError: (error) =>
      console.error('Identity database connection failed', error),
  });
  const app = await buildRuntimeApp(
    config,
    {},
    observability,
    undefined,
    connections,
  );
  t.onTestFinished(async () => {
    await app.close();
    await identity.close();
  });

  async function request(user, path, method = 'GET', body, status = 200) {
    const response = await app.inject({
      method,
      url: path,
      headers: { origin, ...(user ? { cookie: user.cookie } : {}) },
      ...(body === undefined ? {} : { payload: body }),
    });
    assert.equal(response.statusCode, status, response.body);

    return response.statusCode === 204 ? null : response.json();
  }

  /**
   * Registers a person. Unless `verified` is false, confirms the address and signs in; an
   * unverified person has no session cookie.
   */
  async function signup(name, { verified = true } = {}) {
    const email = `${name.toLowerCase()}@example.test`;
    const password = 'settings-test-password-123';
    const response = await app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      headers: { origin },
      payload: {
        name,
        email,
        dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
        password,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const id = response.json().user.id;
    if (!verified) return { id, email, cookie: '' };
    await verifyEmail(db.owner, email);
    const signedIn = await app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email, password },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    const cookies = signedIn.headers['set-cookie'];

    return {
      id,
      email,
      cookie: (Array.isArray(cookies) ? cookies : [cookies])
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  }

  const owner = await signup('Owner');
  const member = await signup('Member');
  const outsider = await signup('Outsider');
  const org = await request(
    owner,
    '/v1/organizations',
    'POST',
    { name: 'Northstar', slug: `northstar-${randomUUID().slice(0, 8)}` },
    201,
  );
  const base = `/v1/organizations/${org.id}`;
  const membership = {
    id: await addMembership(db.owner, org.id, member.id, 'member'),
  };
  const command = (body) => ({ commandId: randomUUID(), ...body });

  return {
    config,
    db,
    app,
    identity,
    owner,
    member,
    outsider,
    org,
    base,
    membership,
    messages,
    request,
    signup,
    command,
    setBeforeSend(callback) {
      beforeSend = callback;
    },
    setFail(value) {
      fail = value;
    },
    /** Makes every send throw this error, such as a provider rate limit, until cleared. */
    setFailWith(error) {
      failWith = error;
    },
    drain: () => identity.mailDelivery.drain(),
  };
}

export function invitationProof(message) {
  const link = message.text.match(
    /https?:\/\/\S+\/app\/invitations\/[^\s]+/,
  )[0];
  const url = new URL(link);

  return {
    organizationId: url.pathname.split('/')[3],
    invitationId: url.pathname.split('/')[4],
    token: url.hash.slice(1),
  };
}
