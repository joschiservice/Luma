import { createHmac } from 'node:crypto';

import { expect, it } from 'vitest';

import { invitationProof, settingsFixture } from './settings-fixture.mjs';

const password = 'settings-test-password-123';
const newPassword = 'replacement-password-123';
const origin = 'http://localhost:3000';

/**
 * Rate limits count per client address, which is the inject socket address here; each fixture
 * has its own counters. Tests that make many sign-in attempts turn limits off.
 */
async function fixture(t, { rateLimit = true } = {}) {
  const f = await settingsFixture(t, origin, { rateLimit });
  const authHeaders = { origin };

  return {
    ...f,
    authHeaders,
    async request(user, path, method = 'GET', body, status = 200) {
      if (!path.startsWith('/auth/'))
        return f.request(user, path, method, body, status);
      const response = await f.app.inject({
        method,
        url: path,
        headers: { ...authHeaders, ...(user ? { cookie: user.cookie } : {}) },
        ...(body === undefined ? {} : { payload: body }),
      });
      expect(response.statusCode, response.body).toBe(status);

      return response.json();
    },
  };
}

function cookies(response) {
  const values = response.headers['set-cookie'];

  return (Array.isArray(values) ? values : [values])
    .filter(Boolean)
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function login(f, user, currentPassword = password) {
  const response = await f.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: f.authHeaders,
    payload: { email: user.email, password: currentPassword },
  });
  expect(response.statusCode, response.body).toBe(200);

  return { ...user, cookie: cookies(response) };
}

function resetToken(f) {
  const message = [...f.messages.values()].findLast(
    (message) => message.subject === 'Reset your Luma password',
  );
  expect(message).toBeDefined();
  const link = new URL(message.text.match(/https?:\/\/\S+/)[0]);
  expect(link.pathname).toBe('/reset-password');
  expect(link.search).toBe('');

  return link.hash.slice(1);
}

function totp(uri) {
  const secret = new URL(uri).searchParams.get('secret');
  const bits = [...secret]
    .map((c) =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
        .indexOf(c)
        .toString(2)
        .padStart(5, '0'),
    )
    .join('');
  const key = Buffer.from(
    bits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();

  return String(
    (digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) %
      1_000_000,
  ).padStart(6, '0');
}

it('changes passwords with current proof, isolates session controls and rejects revoked sessions', async (t) => {
  // Password changes repeat faster than their per-address limit allows.
  const f = await fixture(t, { rateLimit: false });
  const other = await login(f, f.owner);
  const third = await login(f, f.owner);
  const list = await f.request(f.owner, '/auth/list-sessions');
  expect(list).toHaveLength(3);
  expect(list.filter((s) => s.current)).toHaveLength(1);
  expect(list[0].lastActiveAt).toBeTruthy();
  expect(list.every((s) => !('token' in s))).toBe(true);
  const outsiderSessions = await f.request(f.outsider, '/auth/list-sessions');
  await f.request(f.owner, '/auth/revoke-session-by-id', 'POST', {
    sessionId: outsiderSessions[0].id,
  });
  await f.request(
    f.owner,
    '/auth/revoke-session',
    'POST',
    { token: 'any' },
    404,
  );
  await f.request(f.outsider, '/v1/organizations');
  await f.request(
    f.owner,
    '/auth/change-password',
    'POST',
    { currentPassword: 'wrong-password', newPassword },
    400,
  );
  await f.request(
    f.owner,
    '/auth/change-password',
    'POST',
    { currentPassword: password, newPassword: 'short' },
    400,
  );
  await f.request(f.owner, '/auth/change-password', 'POST', {
    currentPassword: password,
    newPassword,
  });
  await f.request(other, '/v1/organizations');
  await f.request(f.owner, '/auth/revoke-session-by-id', 'POST', {
    sessionId: list.find((s) => !s.current).id,
  });
  expect((await f.request(f.owner, '/auth/list-sessions')).length).toBe(2);
  const remaining = await f.request(f.owner, '/auth/list-sessions');
  await f.request(f.owner, '/auth/revoke-other-sessions', 'POST', {});
  await f.request(other, '/v1/organizations', 'GET', undefined, 401);
  await f.request(third, '/v1/organizations', 'GET', undefined, 401);
  expect((await f.request(f.owner, '/auth/list-sessions')).length).toBe(1);
  await f.request(f.owner, '/auth/revoke-session-by-id', 'POST', {
    sessionId: remaining.find((s) => s.current).id,
  });
  await f.request(f.owner, '/v1/organizations', 'GET', undefined, 401);
  const fresh = await login(f, f.owner, newPassword);
  const another = await login(f, f.owner, newPassword);
  const changed = await f.app.inject({
    method: 'POST',
    url: '/auth/change-password',
    headers: { ...f.authHeaders, cookie: fresh.cookie },
    payload: {
      currentPassword: newPassword,
      newPassword: password,
      revokeOtherSessions: true,
    },
  });
  expect(changed.statusCode, changed.body).toBe(200);
  await f.request(another, '/v1/organizations', 'GET', undefined, 401);
  await f.request(
    { ...f.owner, cookie: cookies(changed) },
    '/v1/organizations',
  );
  await f.drain();
  expect(
    [...f.messages.values()].filter(
      (m) => m.subject === 'Your Luma password changed',
    ),
  ).toHaveLength(2);
  const events = (
    await f.db.owner.query(
      'SELECT event_type,reason_code FROM account_security_events WHERE user_id=$1',
      [f.owner.id],
    )
  ).rows;
  expect(
    events.filter((e) => e.event_type === 'password.changed'),
  ).toHaveLength(2);
  expect(
    events.some(
      (e) => e.event_type === 'sessions.revoked' && e.reason_code === 'others',
    ),
  ).toBe(true);
});

it('returns uniform recovery responses, retries mail, consumes links once and expires them', async (t) => {
  const f = await fixture(t);
  const known = await f.request(null, '/auth/request-password-reset', 'POST', {
    email: f.owner.email,
  });
  const unknown = await f.request(
    null,
    '/auth/request-password-reset',
    'POST',
    { email: 'unknown@example.test' },
  );
  expect(known).toEqual(unknown);
  expect(
    (await f.db.owner.query('SELECT reset_token FROM password_security_mail'))
      .rows[0].reset_token,
  ).not.toMatch(/^[a-zA-Z0-9]{24}$/);
  f.setFail(true);
  await f.drain();
  expect(f.messages.size).toBe(0);
  f.setFail(false);
  await f.db.owner.query(
    'UPDATE password_security_mail SET next_attempt_at=now()',
  );
  await f.drain();
  const token = resetToken(f);
  const another = await login(f, f.owner);
  const results = await Promise.all(
    [1, 2].map(() =>
      f.app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        headers: f.authHeaders,
        payload: { token, newPassword },
      }),
    ),
  );
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  await f.request(f.owner, '/v1/organizations', 'GET', undefined, 401);
  await f.request(another, '/v1/organizations', 'GET', undefined, 401);
  await login(f, f.owner, newPassword);
  await f.request(
    null,
    '/auth/reset-password',
    'POST',
    { token, newPassword },
    400,
  );
  await f.request(null, '/auth/request-password-reset', 'POST', {
    email: f.owner.email,
  });
  await f.drain();
  const expired = resetToken(f);
  await f.db.owner.query(
    "UPDATE verifications SET expires_at=now()-interval '1 second' WHERE value=$1 AND identifier LIKE 'reset-password:%'",
    [f.owner.id],
  );
  await f.request(
    null,
    '/auth/reset-password',
    'POST',
    { token: expired, newPassword: password },
    400,
  );
  await f.request(
    null,
    '/auth/request-password-reset',
    'POST',
    { email: 'unknown@example.test' },
    429,
  );
  const events = (
    await f.db.owner.query(
      "SELECT event_type FROM account_security_events WHERE user_id=$1 AND event_type='password.reset'",
      [f.owner.id],
    )
  ).rows;
  expect(events).toHaveLength(1);
  expect(
    [...f.messages.values()].some(
      (m) => m.subject === 'Your Luma password changed',
    ),
  ).toBe(true);
});

it('requires recent sign-in for two-factor password changes and keeps the factor after recovery', async (t) => {
  const f = await fixture(t);
  const setup = await f.request(f.owner, '/auth/two-factor/enable', 'POST', {
    password,
  });
  const confirm = await f.app.inject({
    method: 'POST',
    url: '/auth/two-factor/verify-totp',
    headers: { ...f.authHeaders, cookie: f.owner.cookie },
    payload: { code: totp(setup.totpURI) },
  });
  expect(confirm.statusCode, confirm.body).toBe(200);
  const owner = { ...f.owner, cookie: cookies(confirm) };
  await f.db.owner.query(
    "UPDATE sessions SET created_at=now()-interval '16 minutes' WHERE user_id=$1",
    [owner.id],
  );
  await f.request(
    owner,
    '/auth/change-password',
    'POST',
    { currentPassword: password, newPassword },
    403,
  );
  await f.request(null, '/auth/request-password-reset', 'POST', {
    email: owner.email,
  });
  await f.drain();
  await f.request(null, '/auth/reset-password', 'POST', {
    token: resetToken(f),
    newPassword,
  });
  await f.request(owner, '/v1/organizations', 'GET', undefined, 401);
  const signIn = await f.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: f.authHeaders,
    payload: { email: owner.email, password: newPassword },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);
  expect(signIn.json().twoFactorRedirect).toBe(true);
  const challenge = { ...owner, cookie: cookies(signIn) };
  await f.request(challenge, '/v1/organizations', 'GET', undefined, 401);
  const verified = await f.app.inject({
    method: 'POST',
    url: '/auth/two-factor/verify-backup-code',
    headers: { ...f.authHeaders, cookie: challenge.cookie },
    payload: { code: setup.backupCodes[0] },
  });
  expect(verified.statusCode, verified.body).toBe(200);
  await f.request(
    { ...owner, cookie: cookies(verified) },
    '/auth/change-password',
    'POST',
    { currentPassword: newPassword, newPassword: password },
  );
});

it('localizes security email and refuses disabled-account reset links', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({
    method: 'POST',
    url: '/auth/request-password-reset',
    headers: {
      ...f.authHeaders,
      cookie: 'luma_locale=de',
      'accept-language': 'en',
    },
    payload: { email: f.owner.email },
  });
  expect(response.statusCode, response.body).toBe(200);
  await f.drain();
  const message = [...f.messages.values()].find(
    (m) => m.subject === 'Dein Luma-Passwort zurücksetzen',
  );
  expect(message?.text).toContain('15 Minuten');
  const token = new URL(message.text.match(/https?:\/\/\S+/)[0]).hash.slice(1);
  await f.db.owner.query(
    "INSERT INTO account_disablements(user_id,disabled_by,reason_category,reason) VALUES($1,$1,'compromised','Account security review')",
    [f.owner.id],
  );
  await f.request(
    null,
    '/auth/reset-password',
    'POST',
    { token, newPassword },
    400,
  );
});

it('creates no session until the email address is confirmed through the emailed link', async (t) => {
  const f = await fixture(t, { rateLimit: false });
  const email = 'dana@example.test';
  const registered = await f.app.inject({
    method: 'POST',
    url: '/auth/sign-up/email',
    headers: f.authHeaders,
    payload: { name: 'Dana', email, password, dataRegion: 'AU' },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  expect(cookies(registered)).toBe('');
  const refused = await f.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: f.authHeaders,
    payload: { email, password },
  });
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json().code).toBe('EMAIL_NOT_VERIFIED');
  expect(cookies(refused)).toBe('');
  // Signing up again with a taken address looks the same and sends nothing new.
  const duplicate = await f.app.inject({
    method: 'POST',
    url: '/auth/sign-up/email',
    headers: f.authHeaders,
    payload: {
      name: 'Owner',
      email: f.owner.email,
      password,
      dataRegion: 'AU',
    },
  });
  expect(duplicate.statusCode, duplicate.body).toBe(200);
  expect(cookies(duplicate)).toBe('');
  await f.drain();
  const confirmations = [...f.messages.values()].filter(
    (m) => m.subject === 'Confirm your email for Luma',
  );
  expect(confirmations.map((m) => m.to)).toEqual([email]);
  const link = new URL(confirmations[0].text.match(/https?:\/\/\S+/)[0]);
  expect(link.pathname).toBe('/verify-email');
  expect(link.search).toBe('');
  await f.request(
    null,
    `/auth/verify-email?token=${encodeURIComponent('not-a-token')}`,
    'GET',
    undefined,
    401,
  );
  const confirmed = await f.app.inject({
    method: 'GET',
    url: `/auth/verify-email?token=${encodeURIComponent(link.hash.slice(1))}`,
    headers: f.authHeaders,
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  // Confirming never signs in, so it can't skip a second factor.
  expect(cookies(confirmed)).toBe('');
  expect(
    (
      await f.db.owner.query(
        'SELECT email_verified FROM users WHERE email=$1',
        [email],
      )
    ).rows[0].email_verified,
  ).toBe(true);
  await login(f, { email });
});

it('refuses invitations for an account whose email address is not confirmed', async (t) => {
  const f = await fixture(t, { rateLimit: false });
  await f.request(
    f.owner,
    `${f.base}/settings/invitations`,
    'POST',
    f.command({ email: f.outsider.email, roleId: 'member' }),
  );
  await f.drain();
  const proof = invitationProof(
    [...f.messages.values()].findLast((m) => m.to === f.outsider.email),
  );
  // Accounts created before confirmation was required keep their sessions but are unconfirmed.
  await f.db.owner.query('UPDATE users SET email_verified=false WHERE id=$1', [
    f.outsider.id,
  ]);
  const refused = await f.request(
    f.outsider,
    '/v1/invitations/accept',
    'POST',
    proof,
    403,
  );
  expect(refused.code).toBe('EMAIL_NOT_VERIFIED');
  expect(
    (
      await f.db.owner.query(
        'SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2',
        [f.org.id, f.outsider.id],
      )
    ).rowCount,
  ).toBe(0);
  await f.db.owner.query('UPDATE users SET email_verified=true WHERE id=$1', [
    f.outsider.id,
  ]);
  await f.request(f.outsider, '/v1/invitations/accept', 'POST', proof);
});

it('announces new factors and removes them when an unconfirmed account is recovered', async (t) => {
  const f = await fixture(t, { rateLimit: false });
  const setup = await f.request(f.owner, '/auth/two-factor/enable', 'POST', {
    password,
  });
  const confirm = await f.app.inject({
    method: 'POST',
    url: '/auth/two-factor/verify-totp',
    headers: { ...f.authHeaders, cookie: f.owner.cookie },
    payload: { code: totp(setup.totpURI) },
  });
  expect(confirm.statusCode, confirm.body).toBe(200);
  await f.drain();
  expect(
    [...f.messages.values()].filter(
      (m) =>
        m.to === f.owner.email &&
        m.subject ===
          'Two-factor authentication was turned on for your Luma account',
    ),
  ).toHaveLength(1);
  await f.db.owner.query(
    "INSERT INTO passkeys(id,user_id,name,credential_id,public_key,counter,device_type,backed_up,created_at) VALUES(gen_random_uuid(),$1,'Unknown','credential-1','key',0,'singleDevice',false,now())",
    [f.owner.id],
  );
  // Someone else may have created an unconfirmed account and added these factors.
  await f.db.owner.query('UPDATE users SET email_verified=false WHERE id=$1', [
    f.owner.id,
  ]);
  await f.request(null, '/auth/request-password-reset', 'POST', {
    email: f.owner.email,
  });
  await f.drain();
  await f.request(null, '/auth/reset-password', 'POST', {
    token: resetToken(f),
    newPassword,
  });
  const account = (
    await f.db.owner.query(
      `SELECT u.email_verified,u.two_factor_enabled,
        (SELECT count(*)::int FROM passkeys WHERE user_id=u.id) AS passkeys,
        (SELECT count(*)::int FROM two_factors WHERE user_id=u.id) AS two_factors,
        (SELECT count(*)::int FROM sessions WHERE user_id=u.id) AS sessions
       FROM users u WHERE u.id=$1`,
      [f.owner.id],
    )
  ).rows[0];
  expect(account).toEqual({
    email_verified: true,
    two_factor_enabled: false,
    passkeys: 0,
    two_factors: 0,
    sessions: 0,
  });
  const events = (
    await f.db.owner.query(
      "SELECT event_type FROM account_security_events WHERE user_id=$1 AND event_type IN ('passkey.removed','two-factor.disabled')",
      [f.owner.id],
    )
  ).rows.map((row) => row.event_type);
  expect(events.sort()).toEqual(['passkey.removed', 'two-factor.disabled']);
  const signIn = await f.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: f.authHeaders,
    payload: { email: f.owner.email, password: newPassword },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);
  expect(signIn.json().twoFactorRedirect).toBeUndefined();
});

it('locks password sign-in for an address after repeated wrong passwords, known or not', async (t) => {
  const f = await fixture(t, { rateLimit: false });
  const attempt = (email, attemptPassword) =>
    f.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: f.authHeaders,
      payload: { email, password: attemptPassword },
    });
  const refusals = [];
  for (const email of [f.member.email, 'nobody@example.test']) {
    for (let i = 0; i < 10; i++)
      expect((await attempt(email, 'wrong-password-123')).statusCode).toBe(401);
    const locked = await attempt(email, password);
    expect(locked.statusCode, locked.body).toBe(429);
    expect(cookies(locked)).toBe('');
    refusals.push(locked.json());
  }
  expect(refusals[0].code).toBe('SIGN_IN_LOCKED');
  // The refusal doesn't reveal whether an account uses the address.
  expect(refusals[1]).toEqual(refusals[0]);
  // Other addresses are unaffected.
  await login(f, f.outsider);
  // The lock ends once the failures leave the window.
  await f.db.owner.query(
    "UPDATE account_security_events SET created_at=now()-interval '16 minutes' WHERE user_id=$1",
    [f.member.id],
  );
  await login(f, f.member);
});

it('limits sign-in attempts per client address', async (t) => {
  const f = await fixture(t);
  const statuses = [];
  for (let i = 0; i < 12; i++)
    statuses.push(
      (
        await f.app.inject({
          method: 'POST',
          url: '/auth/sign-in/email',
          headers: f.authHeaders,
          payload: {
            email: `person-${i}@example.test`,
            password: 'wrong-password-123',
          },
        })
      ).statusCode,
    );
  // The fixture's three sign-ins already counted against this address.
  expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  expect(statuses.at(-1)).toBe(429);
});
