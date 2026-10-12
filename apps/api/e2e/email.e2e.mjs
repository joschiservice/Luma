import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { MailRateLimited } from '@luma/identity';
import { expect, it } from 'vitest';

import { settingsFixture } from './settings-fixture.mjs';

const webhookKey = randomBytes(24);
const webhookSecret = `whsec_${webhookKey.toString('base64')}`;

/** Posts a Resend delivery event signed like Resend does, or with a wrong key. */
async function postEvent(f, event, key = webhookKey) {
  const payload = JSON.stringify(event);
  const id = `msg_${randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest('base64');

  return f.app.inject({
    method: 'POST',
    url: '/v1/email/resend/events',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
    payload,
  });
}

const event = (type, messageId, to, extra = {}) => ({
  type,
  created_at: new Date().toISOString(),
  data: {
    created_at: new Date().toISOString(),
    email_id: `provider-${messageId}`,
    message_id: `<${messageId}@example.test>`,
    from: 'Luma <notifications@example.test>',
    to: [to],
    subject: 'Luma',
    ...extra,
  },
});

const latest = (f, to) =>
  [...f.messages.values()].filter((m) => m.to === to).at(-1);

it('writes email in the language each recipient chose, with HTML and text parts', async (t) => {
  const f = await settingsFixture(t);
  const { request, owner, member, base, command, org } = f;

  // A language picked in Luma is stored on the account and used for later email.
  await request(member, '/v1/account/language', 'PUT', { language: 'de' }, 204);
  await request(
    member,
    `${base}/settings/notifications/test`,
    'POST',
    command({}),
  );
  await request(
    owner,
    `${base}/settings/notifications/test`,
    'POST',
    command({}),
  );
  await f.drain();
  const german = latest(f, member.email);
  expect(german.subject).toBe('Deine Luma-Test-E-Mail');
  expect(german.html).toContain('lang="de"');
  expect(german.text).toContain(`für ${org.name}`);
  expect(german.text).toContain(`/app/${org.id}/settings/notifications`);
  expect(latest(f, owner.email).subject).toBe('Your Luma test email');

  // An invitation uses the invitee's language when they have an account, else the inviter's.
  await request(owner, '/v1/account/language', 'PUT', { language: 'de' }, 204);
  await request(
    owner,
    `${base}/settings/invitations`,
    'POST',
    command({ email: 'new.person@example.test', roleId: 'admin' }),
  );
  await f.drain();
  const invitation = latest(f, 'new.person@example.test');
  expect(invitation.subject).toBe(`Tritt ${org.name} in Luma bei`);
  expect(invitation.text).toContain('Owner hat dich mit der Rolle Admin');
  expect(invitation.text).toMatch(/\/app\/invitations\/\S+#\S+/);

  // Signing in records the language the person picked in that browser.
  const signIn = await f.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin: 'http://localhost:3000', cookie: 'luma_locale=en' },
    payload: { email: owner.email, password: 'settings-test-password-123' },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);
  const stored = await f.db.owner.query(
    'SELECT locale FROM users WHERE id=$1',
    [owner.id],
  );
  expect(stored.rows[0].locale).toBe('en');

  await request(null, '/v1/account/language', 'PUT', { language: 'de' }, 401);
});

it('waits out a provider rate limit without spending an attempt', async (t) => {
  const f = await settingsFixture(t);
  const { request, owner, base, command } = f;
  await request(
    owner,
    `${base}/settings/notifications/test`,
    'POST',
    command({}),
  );
  f.setFailWith(new MailRateLimited(120));
  await f.drain();
  const [deferred] = (
    await f.db.owner.query(
      "SELECT state,attempts,next_attempt_at>now()+interval '100 seconds' AS later FROM workspace_mail WHERE kind='test'",
    )
  ).rows;
  expect(deferred).toEqual({ state: 'queued', attempts: 0, later: true });

  f.setFailWith(undefined);
  await f.db.owner.query(
    "UPDATE workspace_mail SET next_attempt_at=now() WHERE kind='test'",
  );
  await f.drain();
  expect(f.messages.size).toBe(1);
});

it('pauses optional email to an address that bounced until a message to it is delivered', async (t) => {
  const f = await settingsFixture(t, 'http://localhost:3000', {
    mailWebhookSecret: webhookSecret,
  });
  const { request, member, base, command } = f;
  await request(
    member,
    `${base}/settings/notifications`,
    'PATCH',
    command({ revision: 0, issues: true, connections: false }),
  );
  await request(
    member,
    `${base}/settings/notifications/test`,
    'POST',
    command({}),
  );
  await f.drain();
  const sent = latest(f, member.email);

  // Unsigned, wrongly signed and unknown events change nothing.
  const bounce = event('email.bounced', sent.id, member.email, {
    bounce: { type: 'Permanent', subType: 'General', message: 'No such user' },
  });
  expect((await postEvent(f, bounce, randomBytes(24))).statusCode).toBe(401);
  expect(
    (
      await postEvent(f, {
        ...bounce,
        data: { ...bounce.data, email_id: 'other' },
      })
    ).statusCode,
  ).toBe(204);
  expect((await request(member, `${base}/settings`)).emailPaused).toBeNull();

  expect((await postEvent(f, bounce)).statusCode).toBe(204);
  expect((await request(member, `${base}/settings`)).emailPaused).toBe(
    'bounced',
  );

  // An issue notification is skipped while paused; a test email is still sent.
  const before = f.messages.size;
  const issue = randomUUID();
  const doc = {
    id: issue,
    tenantId: f.org.id,
    state: 'awaiting_approval',
    fingerprint: 'b'.repeat(64),
    occurrenceCount: 1,
    exceptionClass: 'sync_failure',
    severity: 'high',
  };
  await f.db.owner.query(
    "INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,'awaiting_approval',$4)",
    [issue, f.org.id, doc.fingerprint, doc],
  );
  await f.db.owner.query(
    'UPDATE exceptions SET version=version+1 WHERE id=$1',
    [issue],
  );
  await f.drain();
  expect(f.messages.size).toBe(before);
  expect(
    (
      await f.db.owner.query(
        "SELECT state FROM workspace_mail WHERE kind='issues' AND target_id=$1",
        [issue],
      )
    ).rows,
  ).toEqual([{ state: 'cancelled' }]);

  await request(
    member,
    `${base}/settings/notifications/test`,
    'POST',
    command({}),
  );
  await f.drain();
  const test = latest(f, member.email);
  expect(f.messages.size).toBe(before + 1);
  expect(
    (await postEvent(f, event('email.delivered', test.id, member.email)))
      .statusCode,
  ).toBe(204);
  expect((await request(member, `${base}/settings`)).emailPaused).toBeNull();
});
