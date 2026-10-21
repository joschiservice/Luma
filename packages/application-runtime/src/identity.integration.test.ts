import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { buildRuntimeApp } from '@luma/application-runtime';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

/** Returns the request cookie header for the cookies a response sets. */
function responseCookies(response: { headers: Record<string, unknown> }) {
  const value = response.headers['set-cookie'];
  const cookies = Array.isArray(value) ? value : value ? [value] : [];

  return cookies
    .map((cookie) => String(cookie).split(';')[0]!)
    .filter((cookie) => !cookie.endsWith('='))
    .join('; ');
}

/** Computes the current RFC 6238 code an authenticator app shows for an otpauth URI. */
function totp(uri: string) {
  const encoded = new URL(uri).searchParams.get('secret')!;
  let bits = '';
  for (const character of encoded)
    bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
      .indexOf(character)
      .toString(2)
      .padStart(5, '0');
  const key = Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;

  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, '0');
}

describe.skipIf(!databaseUrl)(
  'identity on PostgreSQL with restricted runtime credentials',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const database = `luma_test_${suffix}`;
    const login = `luma_test_${suffix}`;
    const password = randomUUID();
    const admin = new Pool({ connectionString: databaseUrl });
    let owner: Pool;
    let runtime: Pool;
    let runtimeUrl: string;
    let app: Awaited<ReturnType<typeof buildRuntimeApp>>;
    const origin = 'http://localhost:3001';
    const secret = 'integration-test-secret-at-least-32-characters';
    let alice: { id: string; cookie: string };
    let bob: { id: string; cookie: string };
    let orgA: string;
    let orgB: string;
    const headers = (cookie: string) => ({ cookie, origin });

    /** Registers a person, confirms the address as the emailed link would, and signs in. */
    async function signup(name: string) {
      const email = `${name}@example.test`;
      const response = await app.inject({
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
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
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
        id: response.json().user.id as string,
        cookie: (Array.isArray(cookies) ? cookies : [cookies!])
          .map((c) => c.split(';')[0])
          .join('; '),
      };
    }

    async function createOrg(cookie: string, slug: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: headers(cookie),
        payload: { name: slug, slug },
      });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({
        dataRegion: 'AU',
        status: 'active',
      });

      return response.json().id as string;
    }

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
        // Session and security tables depend on later migrations, so apply the full history.
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
      await admin.query(`GRANT luma_identity, luma_connectors TO "${login}"`);
      url.username = login;
      url.password = password;
      runtimeUrl = url.toString();
      runtime = new Pool({ connectionString: url.toString(), max: 1 });
      app = await buildRuntimeApp({
        databaseUrl: url.toString(),
        secret,
        baseURL: origin,
        trustedOrigins: [origin],
        // The suite signs in many times from one inject address.
        rateLimit: { enabled: false },
      });
      app.get(
        '/v1/organizations/:organizationId/probe',
        { config: { access: { access: 'member' } } },
        async (request) => ({
          tenantId: request.tenantContext?.tenantId,
          actorId: request.tenantContext?.actor.id,
        }),
      );
      alice = await signup('alice');
      bob = await signup('bob');
      orgA = await createOrg(alice.cookie, 'alice');
      orgB = await createOrg(bob.cookie, 'bob');
    }, 30000);
    afterAll(async () => {
      await app?.close();
      await runtime?.end();
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.query(`DROP ROLE IF EXISTS "${login}"`);
      await admin.end();
    });
    it('keeps sessions separate when two apps share a hostname', async () => {
      const apps = await Promise.all(
        ['checkout-a', 'checkout-b'].map((cookiePrefix) =>
          buildRuntimeApp({
            databaseUrl: runtimeUrl,
            secret,
            baseURL: origin,
            trustedOrigins: [origin],
            cookiePrefix,
          }),
        ),
      );
      try {
        const cookies: string[] = [];
        for (const [index, instance] of apps.entries()) {
          const response = await instance.inject({
            method: 'POST',
            url: '/auth/sign-in/email',
            headers: { origin },
            payload: {
              email: `${index === 0 ? 'alice' : 'bob'}@example.test`,
              dataRegion: 'AU',
              password: 'test-password-long-enough',
            },
          });
          expect(response.statusCode, response.body).toBe(200);
          const value = response.headers['set-cookie'];
          cookies.push(
            ...(Array.isArray(value) ? value : [value!]).map(
              (item) => item.split(';')[0]!,
            ),
          );
        }
        expect(
          cookies.some((cookie) =>
            cookie.startsWith('checkout-a.session_token='),
          ),
        ).toBe(true);
        expect(
          cookies.some((cookie) =>
            cookie.startsWith('checkout-b.session_token='),
          ),
        ).toBe(true);
        for (const [index, instance] of apps.entries()) {
          const response = await instance.inject({
            url: '/v1/organizations',
            headers: headers(cookies.join('; ')),
          });
          expect(response.statusCode, response.body).toBe(200);
          expect(
            response.json().items.map((item: { id: string }) => item.id),
          ).toEqual([index === 0 ? orgA : orgB]);
        }
      } finally {
        await Promise.all(apps.map((instance) => instance.close()));
      }
    });
    it('authenticates sessions and lists only the caller’s organizations', async () => {
      const list = await app.inject({
        url: '/v1/organizations',
        headers: headers(alice.cookie),
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().items.map((o: { id: string }) => o.id)).toEqual([
        orgA,
      ]);
      const context = await app.inject({
        url: `/v1/organizations/${orgA}/context`,
        headers: headers(alice.cookie),
      });
      expect(context.statusCode, context.body).toBe(200);
      expect(context.json()).toMatchObject({
        tenantId: orgA,
        dataRegion: 'AU',
        actor: {
          type: 'user',
          id: alice.id,
          initiatingUserId: alice.id,
          role: { id: 'owner', key: 'owner', name: 'Owner', builtIn: true },
        },
        allAppPermissions: true,
        requestId: context.headers['x-request-id'],
      });
      expect(JSON.stringify(context.json())).not.toContain(alice.cookie);
      const probe = await app.inject({
        url: `/v1/organizations/${orgA}/probe`,
        headers: headers(alice.cookie),
      });
      expect(probe.json()).toEqual({ tenantId: orgA, actorId: alice.id });
      expect(
        (
          await app.inject({
            url: `/v1/organizations/${orgB}/probe`,
            headers: headers(alice.cookie),
          })
        ).statusCode,
      ).toBe(404);
    });
    it('records session activity at most once per five minutes', async () => {
      // The signed cookie value is "<token>.<signature>".
      const token = decodeURIComponent(
        bob.cookie.match(/session_token=([^;]+)/)![1]!,
      ).split('.')[0];
      const session = await owner.query<{ id: string }>(
        'SELECT id FROM sessions WHERE token=$1',
        [token],
      );
      const { id } = session.rows[0]!;
      const lastActive = async () =>
        (
          await owner.query<{ last_active_at: Date }>(
            'SELECT last_active_at FROM sessions WHERE id=$1',
            [id],
          )
        ).rows[0]!.last_active_at.getTime();
      const read = async () =>
        expect(
          (
            await app.inject({
              url: '/v1/organizations',
              headers: headers(bob.cookie),
            })
          ).statusCode,
        ).toBe(200);
      const recent = new Date(Date.now() - 4 * 60_000);
      await owner.query('UPDATE sessions SET last_active_at=$1 WHERE id=$2', [
        recent,
        id,
      ]);
      await read();
      await read();
      expect(await lastActive()).toBe(recent.getTime());
      const stale = new Date(Date.now() - 6 * 60_000);
      await owner.query('UPDATE sessions SET last_active_at=$1 WHERE id=$2', [
        stale,
        id,
      ]);
      await read();
      expect(await lastActive()).toBeGreaterThan(Date.now() - 60_000);
    });
    it('rejects missing, forged and foreign sessions without exposing tenant existence', async () => {
      for (const cookie of ['', 'better-auth.session_token=forged']) {
        const response = await app.inject({
          url: `/v1/organizations/${orgA}/context`,
          headers: headers(cookie),
        });
        expect(response.statusCode, response.body).toBe(401);
      }
      for (const id of [orgB, randomUUID()]) {
        const response = await app.inject({
          url: `/v1/organizations/${id}/members`,
          headers: {
            ...headers(alice.cookie),
            'x-organization-id': orgA,
            'x-data-region': 'AU',
          },
        });
        expect(response.statusCode, response.body).toBe(404);
        expect(response.json().message).toBe('Organization not found');
      }
    });
    it('rejects region overrides, identity injection and cross-origin mutations', async () => {
      for (const dataRegion of ['US', 'EU']) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/organizations',
          headers: headers(alice.cookie),
          payload: { name: 'Other', slug: 'other', dataRegion },
        });
        expect(response.statusCode, response.body).toBe(422);
      }
      for (const forged of [
        { userId: bob.id },
        { tenantId: orgB },
        { status: 'closed' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/organizations',
          headers: headers(alice.cookie),
          payload: { name: 'Other', slug: 'other', ...forged },
        });
        expect(response.statusCode).toBe(400);
      }
      const response = await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie: alice.cookie, origin: 'https://evil.example' },
        payload: { name: 'Other', slug: 'other' },
      });
      expect(response.statusCode).toBe(403);
      const bypass = await app.inject({
        method: 'POST',
        url: '/auth/organization/create',
        headers: headers(alice.cookie),
        payload: { name: 'Other', slug: 'other', userId: bob.id },
      });
      expect(bypass.statusCode).toBe(404);
    });
    it('supports multiple memberships, role guards, scoped mutation and immediate revocation', async () => {
      // People join by invitation; no customer route adds an account by ID.
      const byId = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgA}/members`,
        headers: headers(alice.cookie),
        payload: { userId: bob.id, roleId: 'member' },
      });
      expect(byId.statusCode, byId.body).toBe(404);
      const memberId = randomUUID();
      await owner.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'member',now())",
        [memberId, orgA, bob.id],
      );
      const list = await app.inject({
        url: '/v1/organizations',
        headers: headers(bob.cookie),
      });
      expect(list.json().items).toHaveLength(2);
      const forbidden = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${orgA}/members/${memberId}`,
        headers: headers(bob.cookie),
        payload: { roleId: 'owner' },
      });
      expect(forbidden.statusCode).toBe(403);
      const foreign = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${orgB}/members/${memberId}`,
        headers: headers(bob.cookie),
        payload: { roleId: 'admin' },
      });
      expect(foreign.statusCode).toBe(404);
      const promoted = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${orgA}/members/${memberId}`,
        headers: headers(alice.cookie),
        payload: { roleId: 'admin' },
      });
      expect(promoted.statusCode, promoted.body).toBe(200);
      const ownership = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${orgA}/members/${memberId}`,
        headers: headers(bob.cookie),
        payload: { roleId: 'owner' },
      });
      expect(ownership.statusCode).toBe(403);
      const removed = await app.inject({
        method: 'DELETE',
        url: `/v1/organizations/${orgA}/members/${memberId}`,
        headers: headers(alice.cookie),
      });
      expect(removed.statusCode, removed.body).toBe(204);
      expect(
        (
          await app.inject({
            url: `/v1/organizations/${orgA}/context`,
            headers: headers(bob.cookie),
          })
        ).statusCode,
      ).toBe(404);
    });
    it('protects the last owner and rolls back failed provisioning', async () => {
      const members = await app.inject({
        url: `/v1/organizations/${orgA}/members`,
        headers: headers(alice.cookie),
      });
      const memberId = members.json().items[0].id;
      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/organizations/${orgA}/members/${memberId}`,
        headers: headers(alice.cookie),
      });
      expect(response.statusCode, response.body).toBe(409);
      await owner.query(
        `CREATE FUNCTION reject_test_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$`,
      );
      await owner.query(
        'CREATE TRIGGER reject_test_member BEFORE INSERT ON memberships FOR EACH ROW EXECUTE FUNCTION reject_test_member()',
      );
      try {
        const failed = await app.inject({
          method: 'POST',
          url: '/v1/organizations',
          headers: headers(alice.cookie),
          payload: { name: 'Rollback', slug: 'rollback' },
        });
        expect(failed.statusCode).toBe(500);
        expect(
          (
            await owner.query(
              "SELECT id FROM organizations WHERE slug = 'rollback'",
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        await owner.query('DROP TRIGGER reject_test_member ON memberships');
      }
    });
    it('fails closed for suspended, closed and unsupported placements', async () => {
      for (const status of ['suspended', 'closed']) {
        await owner.query(
          'UPDATE organizations SET status = $1 WHERE id = $2',
          [status, orgA],
        );
        expect(
          (
            await app.inject({
              url: `/v1/organizations/${orgA}/context`,
              headers: headers(alice.cookie),
            })
          ).statusCode,
        ).toBe(404);
      }
      await owner.query(
        "UPDATE organizations SET status = 'active', data_region = 'US' WHERE id = $1",
        [orgA],
      );
      expect(
        (
          await app.inject({
            url: `/v1/organizations/${orgA}/context`,
            headers: headers(alice.cookie),
          })
        ).statusCode,
      ).toBe(503);
      await owner.query(
        "UPDATE organizations SET data_region = 'AU' WHERE id = $1",
        [orgA],
      );
    });
    it('enforces RLS, immutable placement/ownership and transaction-local pool context', async () => {
      for (const table of [
        'organizations',
        'memberships',
        'invitations',
        'workspace_roles',
        'workspace_role_permissions',
      ])
        expect((await runtime.query(`SELECT * FROM ${table}`)).rows).toEqual(
          [],
        );
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true)", [
          alice.id,
        ]);
        expect(
          (await client.query('SELECT tenant_id FROM memberships')).rows,
        ).toEqual([{ tenant_id: orgA }]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [
          orgA,
        ]);
        expect(
          (await client.query('SELECT id FROM organizations')).rows,
        ).toEqual([{ id: orgA }]);
        expect(
          (
            await client.query('DELETE FROM memberships WHERE tenant_id = $1', [
              orgB,
            ])
          ).rowCount,
        ).toBe(0);
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true)", [
          bob.id,
        ]);
        expect(
          (await client.query('SELECT id FROM organizations')).rows,
        ).toEqual([{ id: orgB }]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect((await runtime.query('SELECT * FROM memberships')).rows).toEqual(
        [],
      );
      await expect(
        runtime.query("UPDATE organizations SET data_region = 'US'"),
      ).rejects.toThrow('permission denied');
      await expect(
        runtime.query('UPDATE memberships SET tenant_id = $1', [orgB]),
      ).rejects.toThrow('permission denied');
      await expect(
        runtime.query('TRUNCATE organizations CASCADE'),
      ).rejects.toThrow('permission denied');
      await owner.query('CREATE TABLE commerce_private(id uuid)');
      await expect(
        runtime.query('SELECT * FROM commerce_private'),
      ).rejects.toThrow('permission denied');
      const roles = await owner.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
        [login],
      );
      expect(roles.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
    it('serializes competing owner removals and keeps one owner', async () => {
      const organizationId = await createOrg(alice.cookie, 'concurrent');
      const bobMemberId = randomUUID();
      await owner.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",
        [bobMemberId, organizationId, bob.id],
      );
      const list = await app.inject({
        url: `/v1/organizations/${organizationId}/members`,
        headers: headers(alice.cookie),
      });
      const aliceMember = list
        .json()
        .items.find((m: { userId: string }) => m.userId === alice.id);
      const responses = await Promise.all([
        app.inject({
          method: 'PATCH',
          url: `/v1/organizations/${organizationId}/members/${aliceMember.id}`,
          headers: headers(alice.cookie),
          payload: { roleId: 'member' },
        }),
        app.inject({
          method: 'PATCH',
          url: `/v1/organizations/${organizationId}/members/${bobMemberId}`,
          headers: headers(bob.cookie),
          payload: { roleId: 'member' },
        }),
      ]);
      expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(
        (
          await owner.query(
            "SELECT id FROM memberships WHERE tenant_id = $1 AND role = 'owner'",
            [organizationId],
          )
        ).rowCount,
      ).toBe(1);
    });
    it('rejects unscoped and foreign writes under RLS and preserves session selection isolation', async () => {
      const client = await runtime.connect();
      try {
        await expect(
          client.query(
            'INSERT INTO memberships(id, tenant_id, user_id, role, created_at) VALUES ($1, $2, $3, $4, now())',
            [randomUUID(), orgA, bob.id, 'member'],
          ),
        ).rejects.toThrow('row-level security');
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)",
          [alice.id, orgA],
        );
        await expect(
          client.query(
            'INSERT INTO memberships(id, tenant_id, user_id, role, created_at) VALUES ($1, $2, $3, $4, now())',
            [randomUUID(), orgB, alice.id, 'member'],
          ),
        ).rejects.toThrow('row-level security');
        await client.query('ROLLBACK');
        expect((await client.query('SELECT * FROM memberships')).rows).toEqual(
          [],
        );
      } finally {
        client.release();
      }
      await owner.query(
        'UPDATE sessions SET active_organization_id = $1 WHERE user_id = $2',
        [orgB, alice.id],
      );
      expect(
        (
          await app.inject({
            url: `/v1/organizations/${orgB}/context`,
            headers: headers(alice.cookie),
          })
        ).statusCode,
      ).toBe(404);
      const context = await app.inject({
        url: `/v1/organizations/${orgA}/context`,
        headers: { ...headers(alice.cookie), 'x-tenant-id': orgB },
      });
      expect(context.json().tenantId).toBe(orgA);
      const duplicate = await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: headers(alice.cookie),
        payload: { name: 'Duplicate', slug: 'bob' },
      });
      expect(duplicate.statusCode, duplicate.body).toBe(409);
      const ownDuplicate = await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: headers(alice.cookie),
        payload: { name: 'Duplicate', slug: 'alice' },
      });
      expect(ownDuplicate.statusCode, ownDuplicate.body).toBe(409);

      expect((await app.inject({ url: '/ready' })).statusCode).toBe(200);
    });
    it('requires a confirmed authenticator code or unused backup code after the password', async () => {
      const password = 'test-password-long-enough';
      const carol = await signup('carol');
      const signIn = () =>
        app.inject({
          method: 'POST',
          url: '/auth/sign-in/email',
          headers: { origin },
          payload: { email: 'carol@example.test', password },
        });
      const verify = (
        cookie: string,
        kind: 'totp' | 'backup-code',
        code: string,
      ) =>
        app.inject({
          method: 'POST',
          url: `/auth/two-factor/verify-${kind}`,
          headers: headers(cookie),
          payload: { code },
        });
      const organizations = (cookie: string) =>
        app.inject({ url: '/v1/organizations', headers: headers(cookie) });

      const wrongPassword = await app.inject({
        method: 'POST',
        url: '/auth/two-factor/enable',
        headers: headers(carol.cookie),
        payload: { password: 'not-the-password' },
      });
      expect(wrongPassword.statusCode, wrongPassword.body).toBe(400);
      const enabled = await app.inject({
        method: 'POST',
        url: '/auth/two-factor/enable',
        headers: headers(carol.cookie),
        payload: { password },
      });
      expect(enabled.statusCode, enabled.body).toBe(200);
      const { totpURI, backupCodes } = enabled.json() as {
        totpURI: string;
        backupCodes: string[];
      };
      expect(totpURI).toMatch(
        /^otpauth:\/\/totp\/Luma:carol%40example\.test\?/,
      );

      // Setup stays inactive until the person proves the authenticator app works.
      const unconfirmed = await signIn();
      expect(unconfirmed.json()).toMatchObject({
        user: { twoFactorEnabled: false },
      });
      const confirmed = await verify(carol.cookie, 'totp', totp(totpURI));
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const rotated = responseCookies(confirmed);
      expect((await organizations(rotated)).statusCode).toBe(200);
      expect((await organizations(carol.cookie)).statusCode).toBe(401);

      const challenge = await signIn();
      expect(challenge.statusCode, challenge.body).toBe(200);
      expect(challenge.json()).toEqual({
        twoFactorRedirect: true,
        twoFactorMethods: ['totp'],
      });
      const pending = responseCookies(challenge);
      expect(pending).not.toContain('session_token=');
      expect((await organizations(pending)).statusCode).toBe(401);
      const trusted = await app.inject({
        method: 'POST',
        url: '/auth/two-factor/verify-totp',
        headers: headers(pending),
        payload: { code: totp(totpURI), trustDevice: true },
      });
      expect(trusted.statusCode, trusted.body).toBe(400);
      expect((await verify(pending, 'totp', '000000')).statusCode).toBe(401);
      const passed = await verify(pending, 'totp', totp(totpURI));
      expect(passed.statusCode, passed.body).toBe(200);
      expect((await organizations(responseCookies(passed))).statusCode).toBe(
        200,
      );
      expect((await verify(pending, 'totp', totp(totpURI))).statusCode).toBe(
        401,
      );

      const backup = await verify(
        responseCookies(await signIn()),
        'backup-code',
        backupCodes[0]!,
      );
      expect(backup.statusCode, backup.body).toBe(200);
      expect((await organizations(responseCookies(backup))).statusCode).toBe(
        200,
      );
      expect(
        (
          await verify(
            responseCookies(await signIn()),
            'backup-code',
            backupCodes[0]!,
          )
        ).statusCode,
      ).toBe(401);

      const session = responseCookies(backup);
      const regenerated = await app.inject({
        method: 'POST',
        url: '/auth/two-factor/generate-backup-codes',
        headers: headers(session),
        payload: { password },
      });
      expect(regenerated.statusCode, regenerated.body).toBe(200);
      const fresh = (regenerated.json() as { backupCodes: string[] })
        .backupCodes;
      expect(fresh).not.toContain(backupCodes[1]);
      expect(
        (
          await verify(
            responseCookies(await signIn()),
            'backup-code',
            backupCodes[1]!,
          )
        ).statusCode,
      ).toBe(401);

      const disabled = await app.inject({
        method: 'POST',
        url: '/auth/two-factor/disable',
        headers: headers(session),
        payload: { password },
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      const direct = await signIn();
      expect(direct.json()).toMatchObject({
        user: { twoFactorEnabled: false },
      });
      expect((await organizations(responseCookies(direct))).statusCode).toBe(
        200,
      );
    });
    it('scopes passkey ceremonies to the configured relying party and hides other factor routes', async () => {
      const dave = await signup('dave');
      const anonymous = await app.inject({
        url: '/auth/passkey/generate-register-options',
        headers: { origin },
      });
      expect(anonymous.statusCode).toBe(401);
      const registration = await app.inject({
        url: '/auth/passkey/generate-register-options',
        headers: headers(dave.cookie),
      });
      expect(registration.statusCode, registration.body).toBe(200);
      expect(registration.json()).toMatchObject({
        rp: { id: 'localhost', name: 'Luma' },
        user: { name: 'dave@example.test' },
      });
      const listed = await app.inject({
        url: '/auth/passkey/list-user-passkeys',
        headers: headers(dave.cookie),
      });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json()).toEqual([]);

      const authentication = await app.inject({
        url: '/auth/passkey/generate-authenticate-options',
        headers: { origin },
      });
      expect(authentication.statusCode, authentication.body).toBe(200);
      expect(authentication.json()).toMatchObject({ rpId: 'localhost' });
      const unknown = await app.inject({
        method: 'POST',
        url: '/auth/passkey/verify-authentication',
        headers: headers(responseCookies(authentication)),
        payload: {
          response: { id: 'unknown', rawId: 'unknown', type: 'public-key' },
        },
      });
      expect(unknown.statusCode, unknown.body).toBe(401);
      expect(responseCookies(unknown)).not.toContain('session_token=');

      for (const url of [
        '/auth/two-factor/get-totp-uri',
        '/auth/two-factor/send-otp',
        '/auth/two-factor/verify-otp',
        '/auth/passkey/update-passkey',
      ]) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: headers(dave.cookie),
          payload: {},
        });
        expect(response.statusCode, url).toBe(404);
      }
    });
    it('invalidates session access immediately after sign-out', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/sign-out',
        headers: headers(alice.cookie),
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(
        (
          await app.inject({
            url: `/v1/organizations/${orgA}/context`,
            headers: headers(alice.cookie),
          })
        ).statusCode,
      ).toBe(401);
      const signin = await app.inject({
        method: 'POST',
        url: '/auth/sign-in/email',
        headers: { origin },
        payload: {
          email: 'alice@example.test',
          dataRegion: 'AU',
          password: 'test-password-long-enough',
        },
      });
      expect(signin.statusCode, signin.body).toBe(200);
    });

    describe('account security events', () => {
      const password = 'test-password-long-enough';
      const userAgent =
        'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0';
      const events = async (userId: string) =>
        (
          await owner.query<{
            event_type: string;
            outcome: string;
            reason_code: string | null;
            session_id: string | null;
            request_id: string;
            user_agent: string | null;
          }>(
            'SELECT event_type,outcome,reason_code,session_id,request_id,user_agent FROM account_security_events WHERE user_id=$1 ORDER BY created_at,id',
            [userId],
          )
        ).rows;
      const post = (
        url: string,
        cookie: string,
        payload: Record<string, unknown>,
      ) =>
        app.inject({
          method: 'POST',
          url,
          headers: { ...headers(cookie), 'user-agent': userAgent },
          payload,
        });
      const signIn = (email: string, secret = password) =>
        post('/auth/sign-in/email', '', { email, password: secret });

      it('records password sign-ins once and answers known and unknown emails identically', async () => {
        const erin = await signup('erin');
        const before = (await events(erin.id)).length;
        const success = await signIn('erin@example.test');
        expect(success.statusCode, success.body).toBe(200);
        const known = await signIn('erin@example.test', 'not-the-password');
        const unknown = await signIn('nobody@example.test', 'not-the-password');
        expect(unknown.statusCode).toBe(known.statusCode);
        expect(unknown.json()).toEqual(known.json());
        expect((await events(erin.id)).slice(before)).toEqual([
          expect.objectContaining({
            event_type: 'sign-in.password',
            outcome: 'succeeded',
            reason_code: null,
            session_id: expect.any(String),
            request_id: success.headers['x-request-id'],
            user_agent: userAgent,
          }),
          expect.objectContaining({
            event_type: 'sign-in.password',
            outcome: 'failed',
            reason_code: 'invalid-credentials',
            session_id: null,
            request_id: known.headers['x-request-id'],
          }),
        ]);
        const anonymous = await owner.query(
          'SELECT * FROM account_security_events WHERE user_id IS NULL AND request_id=$1',
          [unknown.headers['x-request-id']],
        );
        expect(anonymous.rows).toEqual([
          expect.objectContaining({
            event_type: 'sign-in.password',
            outcome: 'failed',
            reason_code: 'invalid-credentials',
            email_hash: createHmac(
              'sha256',
              Buffer.from(
                hkdfSync(
                  'sha256',
                  secret,
                  'luma-auth-secret',
                  'luma:security-event-email:v1',
                  32,
                ),
              ).toString('hex'),
            )
              .update('account-security-email:nobody@example.test')
              .digest('hex'),
          }),
        ]);
        const stored = JSON.stringify(
          (await owner.query('SELECT * FROM account_security_events')).rows,
        );
        expect(stored).not.toContain('nobody@example.test');
        expect(stored).not.toContain('not-the-password');
        expect(stored).not.toContain(password);
      });

      it('records factor, password and session changes exactly once, including retries', async () => {
        const frank = await signup('frank');
        const enabled = await post('/auth/two-factor/enable', frank.cookie, {
          password,
        });
        const { totpURI } = enabled.json() as { totpURI: string };
        const confirmed = await post(
          '/auth/two-factor/verify-totp',
          frank.cookie,
          { code: totp(totpURI) },
        );
        expect(confirmed.statusCode, confirmed.body).toBe(200);
        let cookie = responseCookies(confirmed);
        const repeated = await post('/auth/two-factor/verify-totp', cookie, {
          code: totp(totpURI),
        });
        expect(repeated.statusCode, repeated.body).toBe(200);
        cookie = responseCookies(repeated) || cookie;
        const codes = await post(
          '/auth/two-factor/generate-backup-codes',
          cookie,
          { password },
        );
        expect(codes.statusCode, codes.body).toBe(200);
        const { backupCodes } = codes.json() as { backupCodes: string[] };

        const challenge = await signIn('frank@example.test');
        expect(challenge.json()).toMatchObject({ twoFactorRedirect: true });
        const pending = responseCookies(challenge);
        expect(
          (
            await post('/auth/two-factor/verify-totp', pending, {
              code: '000000',
            })
          ).statusCode,
        ).toBe(401);
        const second = await post(
          '/auth/two-factor/verify-backup-code',
          pending,
          { code: backupCodes[0] },
        );
        expect(second.statusCode, second.body).toBe(200);
        const other = responseCookies(second);

        for (let attempt = 0; attempt < 2; attempt++) {
          const disabled = await post('/auth/two-factor/disable', cookie, {
            password,
          });
          expect(disabled.statusCode, disabled.body).toBe(200);
          cookie = responseCookies(disabled) || cookie;
        }
        for (let attempt = 0; attempt < 2; attempt++)
          expect(
            (await post('/auth/revoke-other-sessions', cookie, {})).statusCode,
          ).toBe(200);
        expect(
          (
            await app.inject({
              url: '/v1/organizations',
              headers: headers(other),
            })
          ).statusCode,
        ).toBe(401);
        const changed = await post('/auth/change-password', cookie, {
          currentPassword: password,
          newPassword: 'another-password-long-enough',
        });
        expect(changed.statusCode, changed.body).toBe(200);

        expect(
          (await events(frank.id)).map((event) => [
            event.event_type,
            event.outcome,
            event.reason_code,
          ]),
        ).toEqual([
          // The fixture's first sign-in after confirming the email address.
          ['sign-in.password', 'succeeded', null],
          ['two-factor.enabled', 'succeeded', null],
          ['two-factor.backup-codes-regenerated', 'succeeded', null],
          ['sign-in.password', 'succeeded', 'second-factor-required'],
          ['sign-in.two-factor', 'failed', 'invalid-code'],
          ['sign-in.two-factor', 'succeeded', 'backup-code'],
          ['two-factor.disabled', 'succeeded', null],
          ['sessions.revoked', 'succeeded', 'others'],
          ['password.changed', 'succeeded', null],
        ]);
      });

      it('ends one own session by ID without exposing session tokens', async () => {
        const ivy = await signup('ivy');
        const jack = await signup('jack');
        const second = await signIn('ivy@example.test');
        expect(second.statusCode, second.body).toBe(200);
        const other = responseCookies(second);
        const list = await app.inject({
          url: '/auth/list-sessions',
          headers: headers(ivy.cookie),
        });
        expect(list.statusCode, list.body).toBe(200);
        const sessions = list.json() as { id: string; current: boolean }[];
        expect(sessions).toHaveLength(2);
        expect(list.body).not.toMatch(/token/i);
        const jackSession = (
          await owner.query<{ id: string }>(
            'SELECT id FROM sessions WHERE user_id=$1',
            [jack.id],
          )
        ).rows[0]!.id;

        for (const sessionId of [jackSession, 'not-a-session'])
          expect(
            (
              await post('/auth/revoke-session-by-id', ivy.cookie, {
                sessionId,
              })
            ).statusCode,
          ).toBe(200);
        expect(
          (
            await app.inject({
              url: '/v1/organizations',
              headers: headers(jack.cookie),
            })
          ).statusCode,
        ).toBe(200);
        const target = sessions.find((session) => !session.current)!.id;
        for (let attempt = 0; attempt < 2; attempt++)
          expect(
            (
              await post('/auth/revoke-session-by-id', ivy.cookie, {
                sessionId: target,
              })
            ).statusCode,
          ).toBe(200);
        expect(
          (
            await app.inject({
              url: '/v1/organizations',
              headers: headers(other),
            })
          ).statusCode,
        ).toBe(401);
        expect(
          (await post('/auth/revoke-session', ivy.cookie, { token: target }))
            .statusCode,
        ).toBe(404);
        expect(
          (await events(ivy.id))
            .filter((event) => event.event_type === 'sessions.revoked')
            .map((event) => [event.outcome, event.reason_code]),
        ).toEqual([['succeeded', 'one']]);
      });

      it('lists only the signed-in person’s own events, newest first, in pages', async () => {
        const grace = await signup('grace');
        const henry = await signup('henry');
        await signIn('henry@example.test', 'not-the-password');
        for (let index = 0; index < 22; index++)
          await owner.query(
            "INSERT INTO account_security_events(id,user_id,event_type,outcome,request_id,created_at) VALUES($1,$2,'passkey.added','succeeded','seed',now()-make_interval(mins=>$3))",
            [randomUUID(), grace.id, index + 1],
          );

        type Page = {
          items: {
            id: string;
            type: string;
            outcome: string;
            createdAt: string;
          }[];
          nextCursor: string | null;
        };

        const list = (cookie: string, cursor?: string) =>
          app.inject({
            url: `/v1/account/security-events${cursor ? `?cursor=${cursor}` : ''}`,
            headers: headers(cookie),
          });
        const first = await list(grace.cookie);
        expect(first.statusCode, first.body).toBe(200);
        const page = first.json() as Page;
        expect(page.items).toHaveLength(20);
        expect(page.nextCursor).toEqual(expect.any(String));
        const next = (
          await list(grace.cookie, page.nextCursor!)
        ).json() as Page;
        // 22 seeded events and the fixture's first sign-in.
        expect(next.items).toHaveLength(3);
        expect(next.nextCursor).toBeNull();
        const items = [...page.items, ...next.items];
        const times = items.map((item) => Date.parse(item.createdAt));
        expect(times).toEqual([...times].sort((a, b) => b - a));
        const own = await owner.query<{ id: string }>(
          'SELECT id FROM account_security_events WHERE user_id=$1',
          [grace.id],
        );
        expect(items.map((item) => item.id).sort()).toEqual(
          own.rows.map((row) => row.id).sort(),
        );
        expect(((await list(henry.cookie)).json() as Page).items).toEqual([
          expect.objectContaining({
            type: 'sign-in.password',
            outcome: 'failed',
          }),
          expect.objectContaining({
            type: 'sign-in.password',
            outcome: 'succeeded',
          }),
        ]);
        expect((await list('')).statusCode).toBe(401);
        expect((await list(grace.cookie, 'not-a-cursor')).statusCode).toBe(422);
      });

      it('fails sign-in without a session cookie when its event cannot be recorded', async () => {
        await owner.query(
          "CREATE FUNCTION reject_security_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'event store unavailable'; END $$",
        );
        await owner.query(
          'CREATE TRIGGER reject_security_event BEFORE INSERT ON account_security_events FOR EACH ROW EXECUTE FUNCTION reject_security_event()',
        );
        try {
          const response = await signIn('erin@example.test');
          expect(response.statusCode).toBe(500);
          expect(responseCookies(response)).not.toContain('session_token=');
        } finally {
          await owner.query(
            'DROP TRIGGER reject_security_event ON account_security_events',
          );
          await owner.query('DROP FUNCTION reject_security_event()');
        }
      });
    });

    describe('custom workspace roles', () => {
      let organizationId: string;
      let carol: { id: string; cookie: string };
      let carolMember: string;
      const commandHeaders = (cookie: string) => ({
        ...headers(cookie),
        'x-command-id': randomUUID(),
      });
      const createRole = (
        cookie: string,
        payload: { name: string; description?: string; permissions: string[] },
        headerValues = commandHeaders(cookie),
      ) =>
        app.inject({
          method: 'POST',
          url: `/v1/organizations/${organizationId}/roles`,
          headers: headerValues,
          payload: { description: '', ...payload },
        });
      const context = async (cookie: string) =>
        (
          await app.inject({
            url: `/v1/organizations/${organizationId}/context`,
            headers: headers(cookie),
          })
        ).json() as {
          permissions: string[];
          actor: { role: { name: string } };
        };
      const assign = (cookie: string, memberId: string, roleId: string) =>
        app.inject({
          method: 'PATCH',
          url: `/v1/organizations/${organizationId}/members/${memberId}`,
          headers: commandHeaders(cookie),
          payload: { roleId },
        });

      beforeAll(async () => {
        // Earlier tests sign out; continue with fresh sessions.
        for (const [person, name] of [
          [alice, 'alice'],
          [bob, 'bob'],
        ] as const) {
          const signin = await app.inject({
            method: 'POST',
            url: '/auth/sign-in/email',
            headers: { origin },
            payload: {
              email: `${name}@example.test`,
              dataRegion: 'AU',
              password: 'test-password-long-enough',
            },
          });
          expect(signin.statusCode, signin.body).toBe(200);
          person.cookie = responseCookies(signin);
        }
        organizationId = await createOrg(alice.cookie, 'roles');
        carol = await signup('role-tester');
        carolMember = randomUUID();
        await owner.query(
          "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'member',now())",
          [carolMember, organizationId, carol.id],
        );
      });

      it('applies a custom role and its edits on the next request', async () => {
        const created = await createRole(alice.cookie, {
          name: 'Buyer',
          permissions: ['procurement.read', 'orders.read'],
        });
        expect(created.statusCode, created.body).toBe(201);
        const role = created.json();
        expect(role).toMatchObject({
          key: 'custom',
          revision: 1,
          memberCount: 0,
        });
        expect(
          (await assign(alice.cookie, carolMember, role.id)).statusCode,
        ).toBe(200);
        const before = await context(carol.cookie);
        expect(before.actor.role.name).toBe('Buyer');
        expect(before.permissions).toEqual(['orders.read', 'procurement.read']);
        expect(
          (
            await app.inject({
              url: `/v1/organizations/${organizationId}/settings/invitations`,
              headers: headers(carol.cookie),
            })
          ).statusCode,
        ).toBe(403);
        const edited = await app.inject({
          method: 'PATCH',
          url: `/v1/organizations/${organizationId}/roles/${role.id}`,
          headers: commandHeaders(alice.cookie),
          payload: {
            name: 'Buyer',
            description: 'Purchasing team',
            permissions: ['procurement.read', 'members.manage'],
            revision: 1,
          },
        });
        expect(edited.statusCode, edited.body).toBe(200);
        expect(edited.json()).toMatchObject({ revision: 2, memberCount: 1 });
        expect((await context(carol.cookie)).permissions).toEqual([
          'members.manage',
          'procurement.read',
        ]);
        expect(
          (
            await app.inject({
              url: `/v1/organizations/${organizationId}/settings/invitations`,
              headers: headers(carol.cookie),
            })
          ).statusCode,
        ).toBe(200);
        const stale = await app.inject({
          method: 'PATCH',
          url: `/v1/organizations/${organizationId}/roles/${role.id}`,
          headers: commandHeaders(alice.cookie),
          payload: {
            name: 'Buyer',
            description: '',
            permissions: [],
            revision: 1,
          },
        });
        expect(stale.statusCode).toBe(409);
        const history = await app.inject({
          url: `/v1/organizations/${organizationId}/roles/${role.id}/history`,
          headers: headers(alice.cookie),
        });
        expect(history.statusCode, history.body).toBe(200);
        expect(
          history.json().items.map((item: { kind: string }) => item.kind),
        ).toEqual(['updated', 'member_assigned', 'created']);
        expect(history.json().items[0]).toMatchObject({
          added: ['members.manage'],
          removed: ['orders.read'],
          actor: { id: alice.id, name: 'alice' },
        });
      });

      it('returns the original result for a replayed command and rejects a reused ID', async () => {
        const replay = commandHeaders(alice.cookie);
        const first = await createRole(
          alice.cookie,
          { name: 'Replay', permissions: ['orders.read'] },
          replay,
        );
        const second = await createRole(
          alice.cookie,
          { name: 'Replay', permissions: ['orders.read'] },
          replay,
        );
        expect(first.statusCode, first.body).toBe(201);
        expect(second.json().id).toBe(first.json().id);
        const reused = await createRole(
          alice.cookie,
          { name: 'Different', permissions: [] },
          replay,
        );
        expect(reused.statusCode).toBe(409);
        expect(
          (await createRole(alice.cookie, { name: 'replay', permissions: [] }))
            .statusCode,
        ).toBe(409);
        expect(
          (
            await createRole(alice.cookie, {
              name: 'Unknown',
              permissions: ['orders.write'],
            })
          ).statusCode,
        ).toBe(422);
      });

      it('rejects concurrent edits of the same revision', async () => {
        const role = (
          await createRole(alice.cookie, { name: 'Racer', permissions: [] })
        ).json();
        const responses = await Promise.all(
          [['orders.read'], ['inventory.read']].map((permissions) =>
            app.inject({
              method: 'PATCH',
              url: `/v1/organizations/${organizationId}/roles/${role.id}`,
              headers: commandHeaders(alice.cookie),
              payload: {
                name: 'Racer',
                description: '',
                permissions,
                revision: 1,
              },
            }),
          ),
        );
        expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      });

      it('prevents granting or assigning permissions the actor lacks', async () => {
        const manager = (
          await createRole(alice.cookie, {
            name: 'Team lead',
            permissions: ['members.manage', 'roles.manage', 'orders.read'],
          })
        ).json();
        expect(
          (await assign(alice.cookie, carolMember, manager.id)).statusCode,
        ).toBe(200);
        expect(
          (
            await createRole(carol.cookie, {
              name: 'Escalated',
              permissions: ['orders.read', 'workspace.approval_policy.manage'],
            })
          ).statusCode,
        ).toBe(403);
        const allowed = await createRole(carol.cookie, {
          name: 'Reader',
          permissions: ['orders.read'],
        });
        expect(allowed.statusCode, allowed.body).toBe(201);
        const self = (await assign(carol.cookie, carolMember, 'admin'))
          .statusCode;
        expect(self).toBe(403);
        const members = await app.inject({
          url: `/v1/organizations/${organizationId}/members`,
          headers: headers(alice.cookie),
        });
        const aliceMember = members
          .json()
          .items.find((m: { userId: string }) => m.userId === alice.id);
        expect(
          (await assign(carol.cookie, aliceMember.id, 'member')).statusCode,
        ).toBe(403);
        expect(
          (await assign(alice.cookie, carolMember, 'member')).statusCode,
        ).toBe(200);
      });

      it('archives only unused roles and revokes their pending invitations', async () => {
        const role = (
          await createRole(alice.cookie, {
            name: 'Seasonal',
            permissions: ['orders.read'],
          })
        ).json();
        expect(
          (await assign(alice.cookie, carolMember, role.id)).statusCode,
        ).toBe(200);
        const invitation = randomUUID();
        await owner.query(
          `INSERT INTO workspace_invitations(tenant_id,id,email,role,custom_role_id,status,token_hash,inviter_id,expires_at)
           VALUES($1,$2,'temp@example.test','custom',$3,'pending','x',$4,now()+interval '1 day')`,
          [organizationId, invitation, role.id, alice.id],
        );
        const archive = (revision: number) =>
          app.inject({
            method: 'POST',
            url: `/v1/organizations/${organizationId}/roles/${role.id}/archive`,
            headers: commandHeaders(alice.cookie),
            payload: { revision },
          });
        expect((await archive(1)).statusCode).toBe(409);
        expect(
          (await assign(alice.cookie, carolMember, 'member')).statusCode,
        ).toBe(200);
        const archived = await archive(1);
        expect(archived.statusCode, archived.body).toBe(200);
        expect(archived.json()).toMatchObject({ archived: true, revision: 2 });
        expect(
          (
            await owner.query(
              'SELECT status FROM workspace_invitations WHERE tenant_id=$1 AND id=$2',
              [organizationId, invitation],
            )
          ).rows[0],
        ).toEqual({ status: 'revoked' });
        expect(
          (await assign(alice.cookie, carolMember, role.id)).statusCode,
        ).toBe(409);
      });

      it('rejects role IDs from another workspace', async () => {
        const foreign = await app.inject({
          method: 'POST',
          url: `/v1/organizations/${orgB}/roles`,
          headers: commandHeaders(bob.cookie),
          payload: { name: 'Foreign', description: '', permissions: [] },
        });
        expect(foreign.statusCode, foreign.body).toBe(201);
        expect(
          (await assign(alice.cookie, carolMember, foreign.json().id))
            .statusCode,
        ).toBe(409);
        const listed = await app.inject({
          url: `/v1/organizations/${organizationId}/roles`,
          headers: headers(carol.cookie),
        });
        expect(listed.statusCode).toBe(200);
        expect(
          listed.json().roles.map((role: { id: string }) => role.id),
        ).not.toContain(foreign.json().id);
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `/v1/organizations/${organizationId}/roles/${foreign.json().id}`,
              headers: commandHeaders(alice.cookie),
              payload: {
                name: 'Taken',
                description: '',
                permissions: [],
                revision: 1,
              },
            })
          ).statusCode,
        ).toBe(404);
      });

      it('resolves context with one membership query that stays fast', async () => {
        const started = performance.now();
        for (let index = 0; index < 50; index += 1) await context(carol.cookie);
        // Generous bound: the lookup adds one join and a subquery, not a round trip.
        expect((performance.now() - started) / 50).toBeLessThan(50);
      });
    });
  },
);
