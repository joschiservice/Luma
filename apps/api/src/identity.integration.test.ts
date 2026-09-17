import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntimeApp } from './app.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
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
    let app: ReturnType<typeof buildRuntimeApp>;
    const origin = 'http://localhost:3001';
    const secret = 'integration-test-secret-at-least-32-characters';
    let alice: { id: string; cookie: string };
    let bob: { id: string; cookie: string };
    let orgA: string;
    let orgB: string;
    const headers = (cookie: string) => ({ cookie, origin });
    async function signup(name: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        headers: { origin },
        payload: {
          name,
          email: `${name}@example.test`,
          password: 'test-password-long-enough',
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const cookies = response.headers['set-cookie'];
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
        dataRegion: 'EU',
        status: 'active',
      });
      return response.json().id as string;
    }
    beforeAll(async () => {
      await admin.query(`CREATE DATABASE "${database}"`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${database}`;
      owner = new Pool({ connectionString: url.toString() });
      await owner.query(
        await readFile(
          new URL('../migrations/0001_identity.sql', import.meta.url),
          'utf8',
        ),
      );
      await admin.query(
        `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(`GRANT luma_identity TO "${login}"`);
      url.username = login;
      url.password = password;
      runtime = new Pool({ connectionString: url.toString(), max: 1 });
      app = buildRuntimeApp({
        databaseUrl: url.toString(),
        secret,
        baseURL: origin,
        trustedOrigins: [origin],
      });
      app.get('/v1/organizations/:organizationId/probe', async (request) => ({
        tenantId: request.tenantContext?.tenantId,
        actorId: request.tenantContext?.actor.id,
      }));
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
        dataRegion: 'EU',
        actor: {
          type: 'user',
          id: alice.id,
          initiatingUserId: alice.id,
          role: 'owner',
        },
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
            'x-data-region': 'EU',
          },
        });
        expect(response.statusCode, response.body).toBe(404);
        expect(response.json().message).toBe('Organization not found');
      }
    });
    it('rejects region overrides, identity injection and cross-origin mutations', async () => {
      for (const dataRegion of ['US', 'APAC']) {
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
      const added = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgA}/members`,
        headers: headers(alice.cookie),
        payload: { userId: bob.id, role: 'member' },
      });
      expect(added.statusCode, added.body).toBe(201);
      const memberId = added.json().id;
      const list = await app.inject({
        url: '/v1/organizations',
        headers: headers(bob.cookie),
      });
      expect(list.json().items).toHaveLength(2);
      const forbidden = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${orgA}/members/${memberId}`,
        headers: headers(bob.cookie),
        payload: { role: 'owner' },
      });
      expect(forbidden.statusCode).toBe(403);
      const foreign = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${orgB}/members/${memberId}`,
        headers: headers(bob.cookie),
        payload: { role: 'admin' },
      });
      expect(foreign.statusCode).toBe(404);
      const promoted = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${orgA}/members/${memberId}`,
        headers: headers(alice.cookie),
        payload: { role: 'admin' },
      });
      expect(promoted.statusCode, promoted.body).toBe(200);
      const ownership = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${orgA}/members/${memberId}`,
        headers: headers(bob.cookie),
        payload: { role: 'owner' },
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
        "UPDATE organizations SET data_region = 'EU' WHERE id = $1",
        [orgA],
      );
    });
    it('enforces RLS, immutable placement/ownership and transaction-local pool context', async () => {
      for (const table of ['organizations', 'memberships', 'invitations'])
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
      const added = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/members`,
        headers: headers(alice.cookie),
        payload: { userId: bob.id, role: 'owner' },
      });
      expect(added.statusCode).toBe(201);
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
          payload: { role: 'member' },
        }),
        app.inject({
          method: 'PATCH',
          url: `/v1/organizations/${organizationId}/members/${added.json().id}`,
          headers: headers(bob.cookie),
          payload: { role: 'member' },
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
          password: 'test-password-long-enough',
        },
      });
      expect(signin.statusCode, signin.body).toBe(200);
    });
  },
);
