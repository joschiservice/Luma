import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { buildRuntimeApp } from '@luma/application-runtime';
import { createIdentity } from '@luma/identity/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  'personal API apps on PostgreSQL with restricted runtime credentials',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const database = `luma_test_${suffix}`;
    const login = `luma_test_${suffix}`;
    const password = randomUUID();
    const admin = new Pool({ connectionString: databaseUrl });
    const origin = 'http://localhost:3001';
    let owner: Pool;
    let runtime: Pool;
    let runtimeUrl: string;
    let app: Awaited<ReturnType<typeof buildRuntimeApp>>;
    let alice: { id: string; cookie: string };
    let bob: { id: string; cookie: string };
    let orgA: string;
    let orgB: string;
    const session = (cookie: string) => ({ cookie, origin });
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

    async function signup(name: string) {
      const email = `${name}@example.test`;
      const created = await app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        headers: { origin },
        payload: {
          name,
          email,
          dataRegion: 'AU',
          password: 'test-password-long-enough',
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      await owner.query('UPDATE users SET email_verified=true WHERE email=$1', [
        email,
      ]);
      const signedIn = await app.inject({
        method: 'POST',
        url: '/auth/sign-in/email',
        headers: { origin },
        payload: { email, password: 'test-password-long-enough' },
      });
      expect(signedIn.statusCode, signedIn.body).toBe(200);
      const cookies = signedIn.headers['set-cookie'];

      return {
        id: created.json().user.id as string,
        cookie: (Array.isArray(cookies) ? cookies : [cookies!])
          .map((cookie) => cookie.split(';')[0])
          .join('; '),
      };
    }

    async function createOrg(cookie: string, slug: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: session(cookie),
        payload: { name: slug, slug },
      });
      expect(response.statusCode, response.body).toBe(201);

      return response.json().id as string;
    }

    async function createApp(
      cookie: string,
      organizationId: string,
      scopes = ['orders.read', 'customers.read'],
    ) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/api-apps`,
        headers: { ...session(cookie), 'x-command-id': randomUUID() },
        payload: { name: 'Reporting', scopes, lifetimeDays: 30 },
      });
      expect(response.statusCode, response.body).toBe(201);

      return response.json() as {
        app: { id: string; status: string };
        token: string;
      };
    }

    const context = (organizationId: string, token: string) =>
      app.inject({
        url: `/v1/organizations/${organizationId}/context`,
        headers: bearer(token),
      });

    beforeAll(async () => {
      await admin.query(`CREATE DATABASE "${database}"`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${database}`;
      owner = new Pool({ connectionString: url.toString() });
      const roleSetup = await admin.connect();
      try {
        // Roles are cluster-wide even though each suite owns a separate database.
        await roleSetup.query(
          "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
        );
        for (const migration of (
          await readdir(new URL('../migrations/', import.meta.url))
        ).sort())
          if (migration.endsWith('.sql'))
            await owner.query(
              await readFile(
                new URL(`../migrations/${migration}`, import.meta.url),
                'utf8',
              ),
            );
      } finally {
        await roleSetup.query(
          "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
        );
        roleSetup.release();
      }
      await owner.query('SELECT luma_provision_cell_region($1)', ['AU']);
      await admin.query(
        `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      // The API login's groups, so public routes reach their real domain services.
      await admin.query(
        `GRANT luma_identity, luma_connectors, luma_case_reader, luma_desk, luma_commerce_sync, luma_sales, luma_adaptive TO "${login}"`,
      );
      url.username = login;
      url.password = password;
      runtimeUrl = url.toString();
      runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
      app = await buildRuntimeApp({
        databaseUrl: url.toString(),
        secret: 'integration-test-secret-at-least-32-characters',
        baseURL: origin,
        trustedOrigins: [origin],
        rateLimit: { enabled: false },
      });
      alice = await signup('alice');
      bob = await signup('bob');
      orgA = await createOrg(alice.cookie, 'alice-api');
      orgB = await createOrg(bob.cookie, 'bob-api');
    }, 30000);

    afterAll(async () => {
      await app?.close();
      await runtime?.end();
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.query(`DROP ROLE IF EXISTS "${login}"`);
      await admin.end();
    });

    it('authenticates a token in its own workspace only, narrowed to its scopes', async () => {
      const { app: created, token } = await createApp(alice.cookie, orgA);

      expect(token).toMatch(/^luma_au_/);
      const own = await context(orgA, token);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json()).toMatchObject({
        actor: { id: alice.id },
        permissions: ['customers.read', 'orders.read'],
        apiApp: { id: created.id },
      });
      expect((await context(orgB, token)).statusCode).toBe(404);
      const members = await app.inject({
        url: `/v1/organizations/${orgA}/members`,
        headers: bearer(token),
      });
      expect(members.statusCode).toBe(403);
      const used = await owner.query(
        'SELECT last_used_at FROM api_app_credentials WHERE tenant_id=$1 AND app_id=$2',
        [orgA, created.id],
      );
      expect(used.rows[0].last_used_at).not.toBeNull();
    });

    it('reads commerce records, issues and activity through public routes', async () => {
      const { token } = await createApp(alice.cookie, orgA, [
        'orders.read',
        'customers.read',
        'issues.read',
        'activity.read',
      ]);
      const range = new URLSearchParams({
        from: new Date(Date.now() - 86_400_000).toISOString(),
        to: new Date().toISOString(),
      });
      for (const path of [
        'orders',
        'customers',
        'exceptions',
        `activity?${range}`,
      ]) {
        const response = await app.inject({
          url: `/v1/organizations/${orgA}/${path}`,
          headers: bearer(token),
        });
        expect(response.statusCode, `${path}: ${response.body}`).toBe(200);
      }
      const unscoped = await app.inject({
        url: `/v1/organizations/${orgA}/inventory`,
        headers: bearer(token),
      });
      expect(unscoped.statusCode).toBe(403);
    });

    it('counts personal data reads hourly and records the first in activity', async () => {
      const { app: created, token } = await createApp(alice.cookie, orgA, [
        'customers.read',
        'products.read',
      ]);
      for (const path of ['customers', 'customers', 'products'])
        expect(
          (
            await app.inject({
              url: `/v1/organizations/${orgA}/${path}`,
              headers: bearer(token),
            })
          ).statusCode,
        ).toBe(200);
      const counted = await owner.query(
        'SELECT route,requests,records FROM api_app_personal_reads WHERE tenant_id=$1 AND app_id=$2',
        [orgA, created.id],
      );
      const events = await owner.query(
        "SELECT actor_id,after_value FROM workspace_access_events WHERE tenant_id=$1 AND target_id=$2 AND event_type='api_app.personal_data_read'",
        [orgA, created.id],
      );
      const listed = await app.inject({
        url: `/v1/organizations/${orgA}/api-apps`,
        headers: session(alice.cookie),
      });

      expect(counted.rows).toEqual([
        { route: '/customers', requests: 2, records: '0' },
      ]);
      expect(events.rows).toEqual([
        {
          actor_id: alice.id,
          after_value: expect.objectContaining({
            name: 'Reporting',
            path: '/customers',
          }),
        },
      ]);
      expect(
        listed
          .json()
          .items.find((item: { id: string }) => item.id === created.id),
      ).toMatchObject({ personalDataReads: { requests: 2, records: 0 } });
    });

    it('queues expiry notices once, and a notice when someone else revokes an app', async () => {
      const { app: created } = await createApp(alice.cookie, orgA);
      await owner.query(
        "UPDATE api_app_credentials SET created_at=now()-interval '25 days',expires_at=now()+interval '5 days' WHERE tenant_id=$1 AND app_id=$2",
        [orgA, created.id],
      );
      const queue = () =>
        runtime.query('SELECT api_apps_queue_expiry_notices(7) AS queued');

      expect((await queue()).rows[0].queued).toBeGreaterThanOrEqual(1);
      expect((await queue()).rows[0].queued).toBe(0);
      const membershipId = randomUUID();
      await owner.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'member',now())",
        [membershipId, orgA, bob.id],
      );
      const bobs = await createApp(bob.cookie, orgA, ['orders.read']);
      const revoked = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgA}/api-apps/${bobs.app.id}/revoke`,
        headers: { ...session(alice.cookie), 'x-command-id': randomUUID() },
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      const mail = await owner.query(
        "SELECT kind,user_id,target_id FROM workspace_mail WHERE tenant_id=$1 AND kind LIKE 'api_app_%' ORDER BY kind",
        [orgA],
      );

      expect(mail.rows).toEqual(
        expect.arrayContaining([
          {
            kind: 'api_app_expiring',
            user_id: alice.id,
            target_id: expect.any(String),
          },
          { kind: 'api_app_revoked', user_id: bob.id, target_id: bobs.app.id },
        ]),
      );
      const sent: { to: string; subject: string }[] = [];
      const mailer = createIdentity({
        databaseUrl: runtimeUrl,
        secret: 'integration-test-secret-at-least-32-characters',
        baseURL: origin,
        trustedOrigins: [origin],
        mailProvider: {
          async send(message) {
            sent.push(message);
          },
        },
      });
      try {
        await mailer.mailDelivery.drain();
      } finally {
        await mailer.close();
      }

      expect(sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            to: 'alice@example.test',
            subject: expect.stringMatching(/^Your API app token expires on /),
          }),
          expect.objectContaining({
            to: 'bob@example.test',
            subject: 'Your API app Reporting was revoked',
          }),
        ]),
      );
      await owner.query(
        'DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',
        [orgA, bob.id],
      );
    });

    it('stores only the token hash, which the runtime role can’t read', async () => {
      const { app: created, token } = await createApp(alice.cookie, orgA);
      const stored = await owner.query(
        'SELECT token_hash FROM api_app_credentials WHERE tenant_id=$1 AND app_id=$2',
        [orgA, created.id],
      );

      expect(stored.rows).toEqual([
        { token_hash: createHash('sha256').update(token).digest('hex') },
      ]);
      await expect(
        runtime.query('SELECT token_hash FROM api_app_credentials'),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('keeps apps tenant-scoped under row-level security', async () => {
      await createApp(bob.cookie, orgB);
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [
          orgB,
        ]);
        const visible = await client.query(
          'SELECT DISTINCT tenant_id FROM api_apps',
        );
        expect(visible.rows).toEqual([{ tenant_id: orgB }]);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('stops the old token when rotated, and every token when revoked', async () => {
      const { app: created, token } = await createApp(alice.cookie, orgA);
      const rotated = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgA}/api-apps/${created.id}/rotate`,
        headers: { ...session(alice.cookie), 'x-command-id': randomUUID() },
        payload: { lifetimeDays: 7 },
      });
      expect(rotated.statusCode, rotated.body).toBe(200);
      const next = rotated.json().token as string;

      expect((await context(orgA, token)).statusCode).toBe(401);
      expect((await context(orgA, next)).statusCode).toBe(200);
      const revoked = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgA}/api-apps/${created.id}/revoke`,
        headers: { ...session(alice.cookie), 'x-command-id': randomUUID() },
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect((await context(orgA, next)).statusCode).toBe(401);
      const events = await owner.query(
        'SELECT event_type FROM workspace_access_events WHERE tenant_id=$1 AND target_id=$2 ORDER BY created_at',
        [orgA, created.id],
      );
      expect(events.rows.map((row) => row.event_type)).toEqual([
        'api_app.created',
        'api_app.rotated',
        'api_app.revoked',
      ]);
    });

    it('deletes a removed member’s apps, so a later invitation never revives them', async () => {
      const membershipId = randomUUID();
      await owner.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'member',now())",
        [membershipId, orgA, bob.id],
      );
      const { token } = await createApp(bob.cookie, orgA, ['orders.read']);
      expect((await context(orgA, token)).statusCode).toBe(200);
      const removed = await app.inject({
        method: 'DELETE',
        url: `/v1/organizations/${orgA}/members/${membershipId}`,
        headers: session(alice.cookie),
      });
      expect(removed.statusCode, removed.body).toBe(204);

      expect((await context(orgA, token)).statusCode).toBe(401);
      const left = await owner.query(
        'SELECT count(*)::int AS count FROM api_apps WHERE tenant_id=$1 AND user_id=$2',
        [orgA, bob.id],
      );
      expect(left.rows[0].count).toBe(0);
    });

    it('revokes a disabled account’s apps for good', async () => {
      const { app: created, token } = await createApp(bob.cookie, orgB);
      await owner.query(
        "INSERT INTO account_disablements(user_id,disabled_by,reason_category,reason) VALUES($1,$2,'compromised','Credentials were leaked.')",
        [bob.id, randomUUID()],
      );
      await owner.query('DELETE FROM account_disablements WHERE user_id=$1', [
        bob.id,
      ]);

      expect((await context(orgB, token)).statusCode).toBe(401);
      const stored = await owner.query(
        'SELECT revoke_reason FROM api_apps WHERE tenant_id=$1 AND id=$2',
        [orgB, created.id],
      );
      expect(stored.rows).toEqual([{ revoke_reason: 'account_disabled' }]);
    });
  },
);
