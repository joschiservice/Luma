import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInstalledConnections } from '#modules/connectors/composition';
import { createTenantDatabase } from '#modules/platform/composition';
import { makeTenantContext } from '#modules/identity/composition';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('installed connections on PostgreSQL', () => {
  const name = `connections_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  let owner: Pool;
  let runtime: Pool;
  const keys = new Map([['test', randomBytes(32)]]);
  const context = (id = randomUUID()) =>
    makeTenantContext(
      { userId: 'admin', sessionId: 'session' },
      { id, name: 'Store', slug: 'store', dataRegion: 'EU', status: 'active' },
      { id: 'membership', organizationId: id, userId: 'admin', role: 'admin' },
      randomUUID(),
    );
  const ctx = context();
  const input = {
    label: 'Store',
    target: { kind: 'shopify', shop: 'example.myshopify.com' },
    permissions: ['products.read'],
    credentials: { token: 'private-credential' },
  };
  const service = () =>
    createInstalledConnections(createTenantDatabase(runtime), {
      keys,
      activeKeyId: 'test',
      refreshContext: async (c) => c,
      verify: async () => ['products.read'],
    });
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    owner = new Pool({ connectionString: url.toString() });
    const lock = await admin.connect();
    try {
      await lock.query(
        "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
      );
      await owner.query(
        await readFile(
          new URL(
            '../migrations/0004_connector_installations.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
    } finally {
      await lock.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
      lock.release();
    }
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(`GRANT luma_connectors TO "${name}"`);
    url.username = name;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString(), max: 2 });
  });
  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.end();
  });
  it('persists encrypted credentials across service restarts and enforces RLS without repository predicates', async () => {
    const connection = await service().install(ctx, input);
    await service().check(ctx, connection.id, 1);
    expect(
      (await service().credential(ctx, connection.id, 'products.read'))
        .credentials.token,
    ).toBe('private-credential');
    const rows = (await owner.query('SELECT * FROM connector_installations'))
      .rows;
    expect(JSON.stringify(rows)).not.toContain('private-credential');
    expect(await service().list(context())).toEqual([]);
    const db = createTenantDatabase(runtime);
    expect(
      (
        await db.transaction(context().tenantId, (tx) =>
          tx.query('SELECT * FROM connector_installations'),
        )
      ).rows,
    ).toEqual([]);
    expect(
      (await runtime.query('SELECT * FROM connector_installations')).rows,
    ).toEqual([]);
    await expect(
      db.transaction(context().tenantId, (tx) =>
        tx.query(
          'INSERT INTO connector_installations SELECT * FROM connector_installations WHERE tenant_id=$1',
          [ctx.tenantId],
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    const foreignId = randomUUID();
    await expect(
      db.transaction(context().tenantId, (tx) =>
        tx.query(
          'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
          [
            ctx.tenantId,
            foreignId,
            { ...rows[0].document, id: foreignId, version: 1 },
            rows[0].secret,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.transaction(ctx.tenantId, (tx) =>
        tx.query('DELETE FROM connector_lifecycle_events'),
      ),
    ).rejects.toThrow();
    await expect(
      db.transaction(ctx.tenantId, (tx) =>
        tx.query("UPDATE connector_lifecycle_events SET event='changed'"),
      ),
    ).rejects.toThrow();
  });
  it('allows one concurrent rotation and commits exactly one matching lifecycle event', async () => {
    const connection = await service().install(ctx, input);
    const results = await Promise.allSettled([
      service().rotate(ctx, connection.id, 1, { token: 'first' }),
      service().rotate(ctx, connection.id, 1, { token: 'second' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const events = (
      await owner.query(
        'SELECT * FROM connector_lifecycle_events WHERE connection_id=$1 ORDER BY version',
        [connection.id],
      )
    ).rows;
    expect(events.map((e) => e.event)).toEqual([
      'installed',
      'credentials_rotated',
    ]);
    expect(JSON.stringify(events)).not.toContain('private-credential');
    await service().disconnect(ctx, connection.id, 2);
    expect(
      (
        await owner.query(
          'SELECT secret FROM connector_installations WHERE id=$1',
          [connection.id],
        )
      ).rows[0].secret,
    ).toBeNull();
  });
  it('rolls back state when lifecycle evidence cannot be committed', async () => {
    const connection = await service().install(ctx, input);
    await owner.query(
      `CREATE FUNCTION reject_connection_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$`,
    );
    await owner.query(
      'CREATE TRIGGER reject_connection_event BEFORE INSERT ON connector_lifecycle_events FOR EACH ROW EXECUTE FUNCTION reject_connection_event()',
    );
    try {
      await expect(
        service().disconnect(ctx, connection.id, 1),
      ).rejects.toThrow();
      expect(
        (await service().list(ctx)).find((c) => c.id === connection.id),
      ).toMatchObject({ status: 'pending', version: 1 });
    } finally {
      await owner.query(
        'DROP TRIGGER reject_connection_event ON connector_lifecycle_events',
      );
    }
  });
});
