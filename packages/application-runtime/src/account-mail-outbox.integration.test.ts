import { randomUUID } from 'node:crypto';

import { createIdentity } from '@luma/identity/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase } from './test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('account security mail outbox', () => {
  const login = `luma_outbox_test_${randomUUID().replaceAll('-', '')}`;
  const origin = 'http://localhost:3209';
  const admin = new Pool({ connectionString: databaseUrl });
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let identity: ReturnType<typeof createIdentity>;

  // Calls the auth handler itself, without the HTTP bridge and its request headers.
  const signUp = (email: string) =>
    identity.handler(
      new Request(`${origin}/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Outbox Person',
          email,
          password: 'outbox-test-password-long-enough',
          dataRegion: 'AU',
        }),
      }),
    );
  const queued = async (email: string) =>
    (
      await database.owner.query<{ kind: string; reset_token: string | null }>(
        'SELECT m.kind,m.reset_token FROM password_security_mail m JOIN users u ON u.id=m.user_id WHERE u.email=$1',
        [email],
      )
    ).rows;

  beforeAll(async () => {
    database = await createMigratedDatabase(databaseUrl!, 'AU');
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(`GRANT luma_identity TO "${login}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${
      (
        await database.owner.query<{ name: string }>(
          'SELECT current_database() AS name',
        )
      ).rows[0]!.name
    }`;
    url.username = login;
    url.password = password;
    identity = createIdentity(
      {
        databaseUrl: url.toString(),
        secret: 'outbox-test-secret-at-least-32-characters',
        baseURL: origin,
        trustedOrigins: [origin],
        rateLimit: { enabled: false },
        mailProvider: { async send() {} },
      },
      { onDatabaseError: () => undefined },
    );
  }, 60000);

  afterAll(async () => {
    await identity?.close();
    await database?.drop();
    await admin.query(`DROP ROLE IF EXISTS "${login}"`);
    await admin.end();
  });

  it('queues one encrypted confirmation link with the new account and one per resend', async () => {
    const email = 'outbox-direct@example.test';
    const response = await signUp(email);
    expect(response.status, await response.clone().text()).toBe(200);
    const rows = await queued(email);
    expect(rows).toEqual([{ kind: 'verify', reset_token: expect.any(String) }]);
    // The stored link is encrypted, never the token from the response or the link itself.
    expect(rows[0]!.reset_token).not.toMatch(/^ey/);
    // Requesting another link runs outside any auth transaction and queues it the same way.
    const resent = await identity.handler(
      new Request(`${origin}/auth/send-verification-email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      }),
    );
    expect(resent.status, await resent.clone().text()).toBe(200);
    expect(await queued(email)).toEqual([
      { kind: 'verify', reset_token: expect.any(String) },
      { kind: 'verify', reset_token: expect.any(String) },
    ]);
  });

  it('creates no account when its confirmation link cannot be queued', async () => {
    await database.owner.query(
      "CREATE FUNCTION reject_security_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$",
    );
    await database.owner.query(
      'CREATE TRIGGER reject_security_mail BEFORE INSERT ON password_security_mail FOR EACH ROW EXECUTE FUNCTION reject_security_mail()',
    );
    const email = 'outbox-failure@example.test';
    try {
      const response = await signUp(email);
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      await database.owner.query(
        'DROP TRIGGER reject_security_mail ON password_security_mail',
      );
      await database.owner.query('DROP FUNCTION reject_security_mail()');
    }
    const accounts = await database.owner.query(
      'SELECT 1 FROM users WHERE email=$1',
      [email],
    );
    expect(accounts.rows).toEqual([]);
    // The address stays free: signing up again creates the account with its link.
    expect((await signUp(email)).status).toBe(200);
    expect(await queued(email)).toHaveLength(1);
  });
});
