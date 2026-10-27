import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase } from './test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

/** Logins that serve customer workspaces and receive their tenant through `app.tenant_id`. */
const tenantLogins = ['luma_api', 'luma_worker'] as const;
/** Every runtime login `scripts/runtime-logins.mjs` provisions. */
const runtimeLogins = [...tenantLogins, 'luma_staff'] as const;

type RuntimeLogin = (typeof runtimeLogins)[number];

type ProvisionRuntimeLogins = (
  client: PoolClient,
  passwords: Record<RuntimeLogin, string>,
) => Promise<void>;

/**
 * Tables with a `tenant_id` column that are deliberately not tenant-scoped by row-level
 * security. Each belongs to the staff plane, where staff act across workspaces under their own
 * session and grant checks, and no customer runtime login can read or write it (asserted below).
 */
const exemptTables: Record<string, string> = {
  staff_audit:
    'Append-only staff audit trail. tenant_id is nullable and names the inspected workspace; staff logins insert only, and reads go through the staff audit role.',
  identity_support_commands:
    'Receipts for staff session revocations, written and read only by the staff identity-support function owner.',
  identity_support_membership_commands:
    'Receipts for staff membership suspensions, written and read only by the staff identity-support function owner.',
};

/**
 * Policies a tenant login may hold that are not keyed to `app.tenant_id`. Each must still be
 * scoped to a verified caller identity.
 */
const userScopedPolicies: Record<string, string> = {
  'workspace_roles.own_role_read':
    'Resolving a tenant context reads the signed-in user’s own custom role, through their membership, before a workspace is selected.',
  'workspace_role_permissions.own_role_read':
    'Resolving a tenant context reads the permissions of the signed-in user’s own custom role before a workspace is selected.',
};

/** Matches policy expressions that gate staff access on a staff session or workspace grant. */
const staffGate = /staff_has_|staff_inspected_workspace|'staff\./;

/** Selects the policies on `relation` that apply to the role in `role`, including inherited ones. */
const appliesTo = (relation: string, role: string) =>
  `${relation} = p.polrelid AND EXISTS (SELECT FROM unnest(p.polroles) pr
    WHERE CASE WHEN pr = 0 THEN true ELSE pg_has_role(${role}, pr, 'USAGE') END)`;

describe.skipIf(!databaseUrl)('tenant row-level security catalog', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let owner: Pool;
  let tenantTables: string[];

  beforeAll(async () => {
    database = await createMigratedDatabase(databaseUrl!);
    owner = database.owner;

    // Provision the real runtime logins so policies are checked against the group roles each
    // process actually inherits, not a copy of that list.
    const module: { provisionRuntimeLogins: ProvisionRuntimeLogins } =
      await import(
        new URL('../scripts/runtime-logins.mjs', import.meta.url).href
      );
    const client = await owner.connect();
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
      );
      await module.provisionRuntimeLogins(client, {
        luma_api: randomUUID(),
        luma_worker: randomUUID(),
        luma_staff: randomUUID(),
      });
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
      client.release();
    }

    const tables = await owner.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public' ORDER BY 1`,
    );
    tenantTables = tables.rows.map((row) => row.name);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('every tenant_id table has RLS enabled and forced', async () => {
    expect(tenantTables.length).toBeGreaterThan(100);
    expect(
      Object.keys(exemptTables).filter((name) => !tenantTables.includes(name)),
    ).toEqual([]);

    // organizations is the tenant root: its id is the tenant and it has no tenant_id column.
    const unprotected = await owner.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
        WHERE c.oid = ANY($1::regclass[]) AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
        ORDER BY 1`,
      [[...tenantTables, 'organizations']],
    );
    expect(
      unprotected.rows
        .map((row) => row.name)
        .filter((name) => !(name in exemptTables)),
    ).toEqual([]);

    // An exemption is only safe while no customer runtime login can reach the table.
    const reachable = await owner.query<{ name: string; login: string }>(
      `SELECT c.relname AS name, l.login FROM pg_class c CROSS JOIN unnest($2::text[]) AS l(login)
        WHERE c.oid = ANY($1::regclass[])
          AND (has_any_column_privilege(l.login, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
            OR has_table_privilege(l.login, c.oid, 'DELETE,TRUNCATE'))
        ORDER BY 1, 2`,
      [Object.keys(exemptTables), tenantLogins],
    );
    expect(reachable.rows).toEqual([]);
    const staffReads = await owner.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
        WHERE c.oid = ANY($1::regclass[]) AND has_any_column_privilege('luma_staff', c.oid, 'SELECT')`,
      [Object.keys(exemptTables)],
    );
    expect(staffReads.rows).toEqual([]);
  });

  it('each has a tenant policy per runtime role', async () => {
    // Runtime roles are the tenant logins and every group role they inherit.
    const missing = await owner.query<{ table: string; role: string }>(
      `WITH roles AS (
        SELECT r.oid, r.rolname FROM pg_roles r
        WHERE EXISTS (SELECT FROM unnest($2::text[]) l(login) WHERE pg_has_role(l.login, r.oid, 'USAGE'))
      )
      SELECT c.relname AS table, r.rolname AS role FROM pg_class c CROSS JOIN roles r
      WHERE c.oid = ANY($1::regclass[])
        AND (has_any_column_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE')
          OR has_table_privilege(r.oid, c.oid, 'DELETE'))
        AND NOT EXISTS (
          SELECT FROM pg_policy p
          WHERE ${appliesTo('c.oid', 'r.oid')}
            AND concat(pg_get_expr(p.polqual, p.polrelid), ' ', pg_get_expr(p.polwithcheck, p.polrelid))
              ~ 'tenant_id.*app\\.tenant_id'
        )
      ORDER BY 1, 2`,
      [tenantTables.filter((name) => !(name in exemptTables)), tenantLogins],
    );
    expect(missing.rows).toEqual([]);
  });

  // Permissive policies are combined with OR, so one policy that ignores the tenant widens every
  // tenant policy beside it.
  it('no permissive policy reachable by a runtime login ignores its tenant or staff gate', async () => {
    const policies = await owner.query<{
      table: string;
      policy: string;
      login: RuntimeLogin;
      expression: string;
    }>(
      `SELECT c.relname AS table, p.polname AS policy, l.login,
        concat(pg_get_expr(p.polqual, p.polrelid), ' ', pg_get_expr(p.polwithcheck, p.polrelid)) AS expression
      FROM pg_class c CROSS JOIN unnest($2::text[]) AS l(login)
      JOIN pg_policy p ON ${appliesTo('c.oid', 'l.login::regrole')}
      WHERE c.oid = ANY($1::regclass[]) AND p.polpermissive
      ORDER BY 1, 2, 3`,
      [tenantTables.filter((name) => !(name in exemptTables)), runtimeLogins],
    );

    expect(policies.rows.length).toBeGreaterThan(0);
    expect(
      policies.rows
        .filter((row) =>
          row.login === 'luma_staff'
            ? !staffGate.test(row.expression)
            : !/app\.tenant_id/.test(row.expression) &&
              !(`${row.table}.${row.policy}` in userScopedPolicies),
        )
        .map(({ table, policy, login }) => `${login}: ${table}.${policy}`),
    ).toEqual([]);
    for (const name of Object.keys(userScopedPolicies))
      expect(
        policies.rows.find((row) => `${row.table}.${row.policy}` === name)
          ?.expression,
      ).toMatch(/app\.user_id/);
  });

  it('with empty app.tenant_id each runtime role reads zero rows', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      // Seed one row for tenant A into every tenant table, the tenant root and nothing else.
      // Disabling triggers (and so foreign keys) and dropping CHECK constraints inside this
      // rolled-back transaction lets one generic row satisfy every table without fixtures; the
      // policies under test are untouched.
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(`DO $$ DECLARE k record; BEGIN
        FOR k IN SELECT co.conrelid::regclass AS relation, co.conname FROM pg_constraint co
          JOIN pg_namespace n ON n.oid = co.connamespace
          WHERE co.contype = 'c' AND co.conrelid <> 0 AND n.nspname = 'public'
        LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', k.relation, k.conname); END LOOP;
      END $$`);
      const inserts = await client.query<{ name: string; statement: string }>(
        `SELECT c.relname AS name, format('INSERT INTO %I (%s) VALUES (%s)', c.relname,
          string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
          string_agg(CASE
            WHEN a.attname = CASE WHEN c.relname = 'organizations' THEN 'id' ELSE 'tenant_id' END
              THEN quote_literal($2) || '::uuid'
            ELSE format('%L::%s', CASE
              WHEN t.typtype = 'e' THEN (SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder LIMIT 1)
              WHEN t.typname = 'uuid' THEN gen_random_uuid()::text
              WHEN t.typcategory = 'N' OR t.typname IN ('xid', 'xid8') THEN '1'
              WHEN t.typname = 'bool' THEN 'true'
              WHEN t.typcategory = 'D' THEN now()::text
              WHEN t.typname IN ('json', 'jsonb') THEN '{}'
              WHEN t.typcategory = 'A' THEN '{}'
              WHEN t.typname = 'bytea' THEN '\\x00'
              WHEN t.typname = 'interval' THEN '1 hour'
              ELSE 'x' END, format_type(a.atttypid, a.atttypmod))
            END, ', ' ORDER BY a.attnum)) AS statement
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        JOIN pg_type t ON t.oid = a.atttypid
        WHERE c.oid = ANY($1::regclass[]) AND a.attgenerated = '' AND a.attidentity = ''
          AND (a.attname IN ('tenant_id', 'id') AND a.attname = CASE WHEN c.relname = 'organizations' THEN 'id' ELSE 'tenant_id' END
            OR (a.attnotnull AND NOT a.atthasdef))
        GROUP BY c.relname ORDER BY 1`,
        [[...tenantTables, 'organizations'], tenantA],
      );
      const unseeded: string[] = [];
      for (const { name, statement } of inserts.rows) {
        await client.query('SAVEPOINT seed');
        try {
          await client.query(statement);
          await client.query('RELEASE SAVEPOINT seed');
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT seed');
          unseeded.push(`${name}: ${String(error)}`);
        }
      }
      expect(unseeded).toEqual([]);
      expect(inserts.rows).toHaveLength(tenantTables.length + 1);

      // Views exposing tenant_id are read too: a view owned by a role that bypasses row
      // security would leak rows here.
      const readable = await client.query<{
        name: string;
        login: RuntimeLogin;
      }>(
        `SELECT c.relname AS name, l.login FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN unnest($1::text[]) AS l(login)
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
            AND (c.relname = 'organizations' OR EXISTS (SELECT FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
            AND has_any_column_privilege(l.login, c.oid, 'SELECT')
          ORDER BY 2, 1`,
        [runtimeLogins],
      );

      const count = async (
        login: RuntimeLogin,
        tenant: string,
        names: string[],
      ) => {
        const visible: string[] = [];
        const failed: string[] = [];
        await client.query('SAVEPOINT context');
        await client.query(`SET LOCAL ROLE ${login}`);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenant,
        ]);
        for (const name of names) {
          await client.query('SAVEPOINT read');
          try {
            const rows = await client.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM "${name}"`,
            );
            await client.query('RELEASE SAVEPOINT read');
            if (rows.rows[0]!.count > 0) visible.push(name);
          } catch (error) {
            await client.query('ROLLBACK TO SAVEPOINT read');
            failed.push(`${name}: ${String(error)}`);
          }
        }
        await client.query('ROLLBACK TO SAVEPOINT context');

        return { visible, failed };
      };

      for (const login of runtimeLogins) {
        const names = readable.rows
          .filter((row) => row.login === login)
          .map((row) => row.name);
        expect(names.length, login).toBeGreaterThan(0);
        for (const tenant of ['', tenantB])
          expect(
            await count(login, tenant, names),
            `${login} as '${tenant}'`,
          ).toEqual({
            visible: [],
            failed: [],
          });
      }

      // The same reads as tenant A see the seeded rows, so the zero counts above come from the
      // policies rather than from empty tables.
      for (const login of tenantLogins) {
        const names = readable.rows
          .filter((row) => row.login === login)
          .map((row) => row.name);
        const own = await count(login, tenantA, names);
        expect(own.failed).toEqual([]);
        expect(own.visible).toEqual(
          expect.arrayContaining(['exceptions', 'orders_entities']),
        );
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it("insert with another tenant's id is rejected", async () => {
    const targets = await owner.query<{ name: string; login: RuntimeLogin }>(
      `SELECT c.relname AS name, l.login FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
        CROSS JOIN unnest($2::text[]) AS l(login)
        WHERE c.oid = ANY($1::regclass[]) AND has_column_privilege(l.login, c.oid, a.attnum, 'INSERT')
        ORDER BY 2, 1`,
      [tenantTables.filter((name) => !(name in exemptTables)), runtimeLogins],
    );
    for (const login of tenantLogins)
      expect(
        targets.rows.filter((row) => row.login === login).length,
        login,
      ).toBeGreaterThan(100);

    const client = await owner.connect();
    const accepted: string[] = [];
    try {
      await client.query('BEGIN');
      // Triggers are disabled so the policy's WITH CHECK, which PostgreSQL evaluates before
      // constraints, is the first check each row meets.
      await client.query('SET LOCAL session_replication_role = replica');
      for (const { name, login } of targets.rows) {
        await client.query('SAVEPOINT attempt');
        try {
          await client.query(`SET LOCAL ROLE ${login}`);
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [
            tenantA,
          ]);
          await client.query(`INSERT INTO "${name}" (tenant_id) VALUES ($1)`, [
            tenantB,
          ]);
          accepted.push(`${login}: ${name} accepted the row`);
        } catch (error) {
          if (!/row-level security policy/.test(String(error)))
            accepted.push(`${login}: ${name} failed with ${String(error)}`);
        }
        await client.query('ROLLBACK TO SAVEPOINT attempt');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(accepted).toEqual([]);
  });

  it('USING (true) policies target only NOLOGIN roles', async () => {
    const open = await owner.query<{ table: string; policy: string }>(
      `SELECT c.relname AS table, p.polname AS policy FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        WHERE pg_get_expr(p.polqual, p.polrelid) = 'true'
          OR pg_get_expr(p.polwithcheck, p.polrelid) = 'true'`,
    );
    expect(open.rows.length).toBeGreaterThan(0);

    // The policy roles themselves must be NOLOGIN, and PUBLIC (role 0) would reach every login.
    // A NOLOGIN role granted to a runtime login would hand it the open policy too. Other suites
    // create their own test logins on this cluster, so membership is checked for the
    // provisioned runtime logins only.
    const reachable = await owner.query<{
      table: string;
      policy: string;
      role: string;
    }>(
      `SELECT c.relname AS table, p.polname AS policy, coalesce(r.rolname, 'PUBLIC') AS role
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        CROSS JOIN unnest(p.polroles) pr
        LEFT JOIN pg_roles r ON r.oid = pr
        WHERE (pg_get_expr(p.polqual, p.polrelid) = 'true' OR pg_get_expr(p.polwithcheck, p.polrelid) = 'true')
          AND (r.oid IS NULL OR r.rolcanlogin
            OR EXISTS (SELECT FROM unnest($1::text[]) l(login) WHERE pg_has_role(l.login, r.oid, 'USAGE')))
        ORDER BY 1, 2, 3`,
      [runtimeLogins],
    );
    expect(reachable.rows).toEqual([]);
  });
});
