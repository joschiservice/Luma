import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { buildRuntimeApp } from '@luma/application-runtime';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

type Page = {
  items: { type: string; id: string; operation: string }[];
  cursor: string;
  hasMore: boolean;
};

// Changes wait for every older transaction in the cluster, including other suites' running in
// parallel, so reads allow far longer than the default test timeout.
describe.skipIf(!databaseUrl)(
  'workspace change feed on PostgreSQL with restricted runtime credentials',
  { timeout: 30_000 },
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const database = `luma_test_${suffix}`;
    const login = `luma_test_${suffix}`;
    const sync = `luma_test_${suffix}_s`;
    const password = randomUUID();
    const admin = new Pool({ connectionString: databaseUrl });
    const origin = 'http://localhost:3001';
    const connections = { a: randomUUID(), b: randomUUID() };
    let owner: Pool;
    let runtime: Pool;
    let pruner: Pool;
    let app: Awaited<ReturnType<typeof buildRuntimeApp>>;
    let orgA: string;
    let orgB: string;
    let token: string;

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

      return (Array.isArray(cookies) ? cookies : [cookies!])
        .map((cookie) => cookie.split(';')[0])
        .join('; ');
    }

    async function createOrg(cookie: string, slug: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie, origin },
        payload: { name: slug, slug },
      });
      expect(response.statusCode, response.body).toBe(201);

      return response.json().id as string;
    }

    /** Adds a source connection without its app guard; fixtures carry consistent keys. */
    async function connect(tenant: string, connection: string) {
      const client = await owner.connect();
      try {
        await client.query("SET session_replication_role='replica'");
        await client.query(
          "INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,'sealed')",
          [
            tenant,
            connection,
            { tenantId: tenant, id: connection, version: 1, status: 'active' },
          ],
        );
      } finally {
        await client.query("SET session_replication_role='origin'");
        client.release();
      }
    }

    async function addCustomer(
      client: Pool | PoolClient,
      tenant: string,
      connection: string,
    ) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,state,contact_shared,address_shared,
          observed_at,observation_id) VALUES($1,$2,$3,$4,'enabled',false,false,now(),$5)`,
        [tenant, connection, `c-${id}`, id, randomUUID()],
      );

      return id;
    }

    const changes = (query: string, organizationId = orgA) =>
      app.inject({
        url: `/v1/organizations/${organizationId}/changes${query}`,
        headers: { authorization: `Bearer ${token}` },
      });

    async function page(query: string) {
      const response = await changes(query);
      expect(response.statusCode, response.body).toBe(200);

      return response.json() as Page;
    }

    async function head() {
      return (await page('')).cursor;
    }

    /**
     * Reads after `cursor` until the expected changes arrive. Changes appear once older
     * transactions finish, including other suites' on the same cluster.
     */
    async function settle(cursor: string, count: number) {
      let result: Page = { items: [], cursor, hasMore: false };
      await expect
        .poll(
          async () => {
            result = await page(`?after=${cursor}`);

            return result.items.length;
          },
          { timeout: 25_000, interval: 100 },
        )
        .toBe(count);

      return result;
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
      for (const [role, groups] of [
        [
          login,
          'luma_identity, luma_connectors, luma_case_reader, luma_desk, luma_commerce_sync, luma_sales, luma_adaptive',
        ],
        [sync, 'luma_commerce_sync'],
      ] as const) {
        await admin.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
        );
        await admin.query(`GRANT ${groups} TO "${role}"`);
      }
      url.username = login;
      url.password = password;
      runtime = new Pool({ connectionString: url.toString(), max: 1 });
      app = await buildRuntimeApp({
        databaseUrl: url.toString(),
        secret: 'integration-test-secret-at-least-32-characters',
        baseURL: origin,
        trustedOrigins: [origin],
        rateLimit: { enabled: false },
      });
      url.username = sync;
      pruner = new Pool({ connectionString: url.toString(), max: 1 });
      const alice = await signup('alice');
      const bob = await signup('bob');
      orgA = await createOrg(alice, 'alice-changes');
      orgB = await createOrg(bob, 'bob-changes');
      await connect(orgA, connections.a);
      await connect(orgB, connections.b);
      const created = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgA}/api-apps`,
        headers: { cookie: alice, origin, 'x-command-id': randomUUID() },
        payload: {
          name: 'Mirror',
          scopes: ['customers.read', 'issues.read'],
          lifetimeDays: 30,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      token = created.json().token as string;
    }, 30000);

    afterAll(async () => {
      await app?.close();
      await runtime?.end();
      await pruner?.end();
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.query(`DROP ROLE IF EXISTS "${login}"`);
      await admin.query(`DROP ROLE IF EXISTS "${sync}"`);
      await admin.end();
    });

    it('lists each changed record once per transaction, in commit order and in its own workspace only', async () => {
      const start = await head();
      expect(await page('')).toMatchObject({ items: [], hasMore: false });

      const client = await owner.connect();
      let first: string;
      try {
        await client.query('BEGIN');
        first = await addCustomer(client, orgA, connections.a);
        await client.query(
          "UPDATE customer_profiles SET state='disabled' WHERE tenant_id=$1 AND id=$2",
          [orgA, first],
        );
        await client.query(
          "UPDATE customer_profiles SET state='unknown' WHERE tenant_id=$1 AND id=$2",
          [orgA, first],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      await addCustomer(owner, orgB, connections.b);
      const second = await addCustomer(owner, orgA, connections.a);
      // An update that changes nothing is not a change.
      await owner.query(
        'UPDATE customer_profiles SET state=state WHERE tenant_id=$1 AND id=$2',
        [orgA, second],
      );

      const result = await settle(start, 2);
      expect(result.items).toMatchObject([
        { type: 'customer', id: first, operation: 'upserted' },
        { type: 'customer', id: second, operation: 'upserted' },
      ]);
      expect(result.hasMore).toBe(false);
      expect((await page(`?after=${result.cursor}`)).items).toEqual([]);
      const paged = await page(`?after=${start}&limit=1`);
      expect(paged).toMatchObject({ items: [{ id: first }], hasMore: true });
      expect(
        (await page(`?after=${paged.cursor}&limit=1`)).items,
      ).toMatchObject([{ id: second }]);
    });

    it('holds back a change until every earlier transaction has committed, so none is skipped', async () => {
      const start = await head();
      const slow = await owner.connect();
      let early: string;
      let late: string;
      try {
        await slow.query('BEGIN');
        early = await addCustomer(slow, orgA, connections.a);
        late = await addCustomer(owner, orgA, connections.a);

        // The later commit stays hidden while the earlier transaction is open.
        const waiting = await page(`?after=${start}`);
        expect(waiting.items).toEqual([]);
        expect(waiting.cursor).toBe(start);
        await slow.query('COMMIT');
      } finally {
        slow.release();
      }

      expect((await settle(start, 2)).items.map((item) => item.id)).toEqual([
        early,
        late,
      ]);
    });

    it('reports a deleted record once, and only record types the app can read', async () => {
      const before = await head();
      const kept = await addCustomer(owner, orgA, connections.a);
      const start = (await settle(before, 1)).cursor;
      await owner.query(
        'DELETE FROM customer_profiles WHERE tenant_id=$1 AND id=$2',
        [orgA, kept],
      );

      expect((await settle(start, 1)).items).toMatchObject([
        { type: 'customer', id: kept, operation: 'deleted' },
      ]);
      expect((await changes('?types=order')).statusCode).toBe(403);
      expect((await changes('?types=customer,issue')).statusCode).toBe(200);
      expect((await changes('?after=not-a-cursor')).statusCode).toBe(400);
      expect((await changes('', orgB)).statusCode).toBe(404);
    });

    it('keeps changes tenant-scoped and writable only through record triggers', async () => {
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [
          orgB,
        ]);
        const rows = await client.query<{ tenant_id: string }>(
          'SELECT DISTINCT tenant_id FROM workspace_changes',
        );
        expect(rows.rows).toEqual([{ tenant_id: orgB }]);
        await expect(
          client.query(
            "INSERT INTO workspace_changes(tenant_id,record_type,record_id,operation) VALUES($1,'customer',$2,'upserted')",
            [orgB, randomUUID()],
          ),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('answers 410 for a cursor before pruned changes and keeps later cursors working', async () => {
      const start = await head();
      await addCustomer(owner, orgA, connections.a);
      const current = (await settle(start, 1)).cursor;
      await owner.query(
        "UPDATE workspace_changes SET recorded_at=now()-interval '31 days' WHERE tenant_id=$1",
        [orgA],
      );

      const pruned = await pruner.query<{ removed: number }>(
        'SELECT prune_workspace_changes(30,1000) AS removed',
      );
      expect(pruned.rows[0]!.removed).toBeGreaterThan(0);

      const expired = await changes(`?after=${start}`);
      expect(expired.statusCode).toBe(410);
      expect(expired.json()).toMatchObject({ code: 'GONE' });
      expect(await page(`?after=${current}`)).toMatchObject({ items: [] });
      expect(await head()).toBe(current);
    });
  },
);
