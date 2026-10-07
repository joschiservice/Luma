import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildRuntimeApp } from '@luma/application-runtime';
import { createIdentity } from '@luma/identity/composition';

import { database, secret } from './helpers.mjs';

export async function settingsFixture(
  t,
  origin = 'http://localhost:3000',
  { connections } = {},
) {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const messages = new Map();
  let fail = false;
  let beforeSend = async () => {};
  const config = {
    databaseUrl: db.runtimeUrl,
    secret,
    baseURL: origin,
    trustedOrigins: [origin],
    mailOrigin: origin,
    mailProvider: {
      async send(message) {
        await beforeSend();
        if (fail) throw new Error('Deterministic mail failure');
        messages.set(message.id, message);
      },
    },
  };
  const identity = createIdentity(config);
  const app = await buildRuntimeApp(
    config,
    {},
    undefined,
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

  async function signup(name) {
    const email = `${name.toLowerCase()}@example.test`;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      headers: { origin },
      payload: { name, email, password: 'settings-test-password-123' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const cookies = response.headers['set-cookie'];

    return {
      id: response.json().user.id,
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
  const membership = await request(
    owner,
    `${base}/members`,
    'POST',
    { userId: member.id, roleId: 'member' },
    201,
  );
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
