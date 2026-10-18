import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDataRetentionWorker } from './composition/data-retention.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const app = 'production:client';

describe.skipIf(!databaseUrl)(
  'retention for closed workspaces and redacted shops',
  () => {
    const name = `retention_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    const closed = randomUUID();
    const recent = randomUUID();
    const active = randomUUID();
    const connections = {
      [closed]: randomUUID(),
      [recent]: randomUUID(),
      [active]: randomUUID(),
    };
    const live = randomUUID();
    const logged: { message: string; detail: string | undefined }[] = [];
    let clock = new Date();
    let owner: Pool;
    let worker: Pool;
    let connectors: Pool;
    let identity: Pool;
    let retention: ReturnType<typeof createDataRetentionWorker>;

    const login = async (role: string, groups: string) => {
      const password = randomUUID();
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(`GRANT ${groups} TO "${role}"`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${name}`;
      url.username = role;
      url.password = password;

      return new Pool({ connectionString: url.toString() });
    };

    beforeAll(async () => {
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${name}`;
      owner = new Pool({ connectionString: url.toString() });
      const setup = await admin.connect();
      try {
        await setup.query(
          "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
        );
        // Core migrations, then each workspace app's, in the shared runner's order, so app
        // tables count in the retention classification.
        const directories = [new URL('../migrations/', import.meta.url)];
        const apps = new URL('../../apps/', import.meta.url);
        for (const app of (await readdir(apps, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort())
          directories.push(new URL(`${app}/migrations/`, apps));
        for (const directory of directories) {
          const files = await readdir(directory).catch(() => []);
          for (const file of files.sort())
            if (file.endsWith('.sql'))
              await owner.query(
                await readFile(new URL(file, directory), 'utf8'),
              );
        }
      } finally {
        await setup.query(
          "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
        );
        setup.release();
      }
      await owner.query('SELECT luma_provision_cell_region($1)', ['AU']);
      worker = await login(`${name}_w`, 'luma_commerce_sync');
      connectors = await login(`${name}_c`, 'luma_connectors');
      identity = await login(`${name}_i`, 'luma_identity');

      for (const id of [closed, recent, active])
        await owner.query(
          "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Workspace',$2,'active',now())",
          [id, `w-${id}`],
        );
      await owner.query(
        "UPDATE organizations SET status='closed' WHERE id=ANY($1)",
        [[closed, recent]],
      );
      await owner.query(
        "UPDATE organizations SET closed_at=now()-interval '120 days' WHERE id=$1",
        [closed],
      );
      const client = await owner.connect();
      try {
        // Fixtures carry consistent keys; replica mode only skips the guards on inserting them.
        await client.query("SET session_replication_role='replica'");
        for (const tenant of [closed, recent, active])
          await seed(client, tenant, connections[tenant]!, 'revoked');
        await seed(client, active, live, 'active');
      } finally {
        await client.query("SET session_replication_role='origin'");
        client.release();
      }
      retention = createDataRetentionWorker({
        pool: worker,
        closureRetentionDays: 90,
        auditRetentionDays: 365,
        // Single-row batches end calls between both sides of every reference.
        batch: 1,
        now: () => clock,
        log: (message, error) =>
          logged.push({
            message,
            detail: error instanceof Error ? error.message : undefined,
          }),
      });
    });

    afterAll(async () => {
      await worker?.end();
      await connectors?.end();
      await identity?.end();
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.query(`DROP ROLE IF EXISTS "${name}_w"`);
      await admin.query(`DROP ROLE IF EXISTS "${name}_c"`);
      await admin.query(`DROP ROLE IF EXISTS "${name}_i"`);
      await admin.end();
    });

    /** Gives a workspace a connection with provider, canonical, customer and audit records. */
    async function seed(
      client: PoolClient,
      tenant: string,
      connection: string,
      status: 'revoked' | 'active',
    ) {
      const [observation, entity, snapshot, entry] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await client.query(
        'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
        [
          tenant,
          connection,
          { tenantId: tenant, id: connection, version: 1, status },
          status === 'active' ? 'sealed' : null,
        ],
      );
      await client.query(
        'INSERT INTO shopify_installation_bindings(tenant_id,app,shop,connection_id) VALUES($1,$2,$3,$4)',
        [tenant, app, `${connection}.myshopify.com`, connection],
      );
      await client.query(
        'INSERT INTO connector_observations(id,tenant_id,connection_id,ingest_key,document) VALUES($1,$2,$3,$4,$5)',
        [
          observation,
          tenant,
          connection,
          `key-${observation}`,
          {
            observation: {
              source: { tenantId: tenant, connectionId: connection },
            },
          },
        ],
      );
      await client.query(
        "INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,'order',$3)",
        [entity, tenant, `order-${entity}`],
      );
      await client.query(
        `INSERT INTO orders_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,
          mapping_version,observed_at,document) VALUES($1,$2,$3,'order',$4,$5,'v1','v1',now(),$6)`,
        [
          snapshot,
          tenant,
          entity,
          connection,
          observation,
          {
            entityId: entity,
            connectionId: connection,
            observationId: observation,
            kind: 'order',
          },
        ],
      );
      // References the snapshot without a connection column of its own.
      await client.query(
        "INSERT INTO orders_projection_events(id,tenant_id,snapshot_id,actor_id) VALUES($1,$2,$3,'sync')",
        [randomUUID(), tenant, snapshot],
      );
      await client.query(
        `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,email,state,contact_shared,address_shared,
          observed_at,observation_id) VALUES($1,$2,'c-1',$3,'kim@customer.example','enabled',true,false,now(),$4)`,
        [tenant, connection, randomUUID(), observation],
      );
      await client.query(
        "INSERT INTO customer_erasures(tenant_id,connection_id,external_digest) VALUES($1,$2,sha256('c-2'))",
        [tenant, connection],
      );
      const audit = randomUUID();
      await client.query(
        'INSERT INTO audit_entries(id,tenant_id,event_key,proposal_id,document,created_at) VALUES($1,$2,$3,$4,$5,now())',
        [
          audit,
          tenant,
          `test-${audit}`,
          randomUUID(),
          { id: audit, tenantId: tenant },
        ],
      );
      // Immutable and self-referencing: a reversal names the entry it reverses.
      for (const [id, purpose, reversal] of [
        [entry, 'movement', null],
        [randomUUID(), 'reversal', entry],
      ] as const)
        await client.query(
          `INSERT INTO inventory_ledger_entries(tenant_id,id,command_key,command_hash,purpose,reason,actor_id,
            evidence_refs,reversal_of,review_id) VALUES($1,$2,$3,$4,$5,'test','sync','[]',$6,$7)`,
          [
            tenant,
            id,
            `command-${id}`,
            'a'.repeat(64),
            purpose,
            reversal,
            reversal ? randomUUID() : null,
          ],
        );
      // An account and its posting reference each other, one side through a deferred key.
      const [sku, location, account] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      for (const [id, kind] of [
        [sku, 'sku'],
        [location, 'location'],
      ])
        await client.query(
          'INSERT INTO inventory_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,$3,$4)',
          [id, tenant, kind, `${kind}-${id}`],
        );
      await client.query(
        `INSERT INTO inventory_ledger_accounts(tenant_id,id,sku_id,location_id,unit,state,balance,version)
        VALUES($1,$2,$3,$4,'each','available',5,1)`,
        [tenant, account, sku, location],
      );
      await client.query(
        `INSERT INTO inventory_ledger_postings(tenant_id,entry_id,account_id,sku_id,unit,account_version,quantity,
          balance_before,balance_after,recorded_at) VALUES($1,$2,$3,$4,'each',1,5,0,5,now())`,
        [tenant, entry, account, sku],
      );
      await client.query(
        'INSERT INTO workspace_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING',
        [tenant],
      );
    }

    /** Counts rows per table for a tenant, optionally one connection's rows only. */
    async function rows(tenant: string) {
      const tables = (
        await owner.query<{ relname: string }>(
          `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
          JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' WHERE c.relkind='r' ORDER BY 1`,
        )
      ).rows.map((r) => r.relname);
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const count = Number(
          (
            await owner.query<{ n: string }>(
              `SELECT count(*) n FROM "${table}" WHERE tenant_id=$1`,
              [tenant],
            )
          ).rows[0]!.n,
        );
        if (count) counts[table] = count;
      }

      return counts;
    }

    const count = async (table: string, tenant: string, connection: string) =>
      Number(
        (
          await owner.query<{ n: string }>(
            `SELECT count(*) n FROM "${table}" WHERE tenant_id=$1 AND connection_id=$2`,
            [tenant, connection],
          )
        ).rows[0]!.n,
      );

    it('removes a shop redacted after uninstall, never a reconnected installation', async () => {
      const before = await rows(active);
      // The live connection is a newer installation; only the uninstalled one is queued.
      for (const connection of [connections[active]!, live])
        await connectors.query('SELECT erase_shopify_shop_data($1,$2)', [
          app,
          `${connection}.myshopify.com`,
        ]);
      await expect(
        worker.query('SELECT * FROM purge_scoped_rows($1,NULL,10,$2)', [
          active,
          [],
        ]),
      ).rejects.toThrow(/permission denied/);
      await retention.pass();

      const shop = connections[active]!;
      for (const table of [
        'connector_observations',
        'orders_snapshots',
        'customer_profiles',
      ])
        expect(await count(table, active, shop)).toBe(0);
      expect(await count('customer_erasures', active, shop)).toBe(1);
      expect(await count('shopify_installation_bindings', active, shop)).toBe(
        1,
      );
      expect(await count('connector_observations', active, live)).toBe(1);
      const after = await rows(active);
      // The removed snapshot's projection event goes with it; canonical identities stay.
      expect(after.orders_projection_events).toBe(1);
      expect(after.orders_entities).toBe(before.orders_entities);
      expect(after.audit_entries).toBe(before.audit_entries);
      expect(
        (
          await owner.query(
            'SELECT outcome FROM connection_data_purges WHERE tenant_id=$1',
            [active],
          )
        ).rows,
      ).toEqual([{ outcome: 'purged' }]);
    });

    it('stops a queued removal when the connection is reconnected first', async () => {
      const shop = connections[recent]!;
      await connectors.query('SELECT erase_shopify_shop_data($1,$2)', [
        app,
        `${shop}.myshopify.com`,
      ]);
      await owner.query(
        `UPDATE connector_installations SET secret='sealed',document=jsonb_set(document,'{status}','"active"')
        WHERE tenant_id=$1 AND id=$2`,
        [recent, shop],
      );
      await retention.pass();
      expect(await count('connector_observations', recent, shop)).toBe(1);
      expect(
        (
          await owner.query(
            'SELECT outcome FROM connection_data_purges WHERE tenant_id=$1',
            [recent],
          )
        ).rows,
      ).toEqual([{ outcome: 'superseded' }]);
    });

    it('announces a deletion date a week ahead at least, then removes the workspace but keeps its identity and audit records', async () => {
      const activeBefore = await rows(active);
      const recentBefore = await rows(recent);
      const dates = async () =>
        Object.fromEntries(
          (
            await owner.query<{ id: string; data_deletion_at: Date | null }>(
              'SELECT id,data_deletion_at FROM organizations WHERE id=ANY($1)',
              [[closed, recent, active]],
            )
          ).rows.map((row) => [row.id, row.data_deletion_at]),
        );
      // Closed 120 days ago with a 90-day window: deletion still waits a week after announcing.
      const announced = await dates();
      expect(announced[active]).toBeNull();
      expect(announced[closed]!.getTime() - Date.now()).toBeGreaterThan(
        6.9 * 86_400_000,
      );
      expect(announced[recent]!.getTime() - Date.now()).toBeGreaterThan(
        89 * 86_400_000,
      );
      // A shorter window never moves an announced date earlier.
      await worker.query('SELECT schedule_closed_workspace_deletions(30)');
      expect(await dates()).toEqual(announced);
      await retention.pass();
      expect(await rows(closed)).not.toEqual({});
      expect((await rows(closed)).connector_observations).toBe(1);

      await owner.query(
        "UPDATE organizations SET data_deletion_at=now()-interval '1 minute' WHERE id=$1",
        [closed],
      );
      await retention.pass();

      // Audit entries wait for their own, longer retention.
      expect(await rows(closed)).toEqual({
        audit_entries: 1,
        workspace_settings: 1,
      });
      expect(await rows(active)).toEqual(activeBefore);
      expect(await rows(recent)).toEqual(recentBefore);
      const organization = (
        await owner.query(
          'SELECT status,data_purged_at FROM organizations WHERE id=$1',
          [closed],
        )
      ).rows[0];
      expect(organization.status).toBe('closed');
      expect(organization.data_purged_at).not.toBeNull();
      await expect(
        owner.query("UPDATE organizations SET status='active' WHERE id=$1", [
          closed,
        ]),
      ).rejects.toThrow('workspace data was removed after closure');
      // Outside a purge, immutable evidence still refuses deletion.
      await expect(
        owner.query('DELETE FROM inventory_ledger_entries WHERE tenant_id=$1', [
          active,
        ]),
      ).rejects.toThrow('inventory_ledger_entries rows are retained');
      expect(logged.filter((l) => l.message.includes('removal'))).toEqual([]);
    });

    it('deletes audit entries of a closed workspace only after the audit retention window', async () => {
      await expect(
        worker.query('SELECT purge_closed_workspace_audit(29,10)'),
      ).rejects.toThrow('audit retention must be at least 30 days');
      // The worker's one-year window has not passed for a workspace closed 120 days ago.
      await retention.pass();
      expect((await rows(closed)).audit_entries).toBe(1);
      await worker.query('SELECT purge_closed_workspace_audit(100,10)');
      expect((await rows(closed)).audit_entries).toBeUndefined();
      // Open workspaces and closures inside the window keep every entry.
      expect((await rows(active)).audit_entries).toBe(2);
      expect((await rows(recent)).audit_entries).toBe(1);
    });

    it('notifies owners once per announced date, reminds them a week ahead and cancels on reopening', async () => {
      const user = randomUUID();
      await owner.query(
        "INSERT INTO users(id,name,email,created_at,updated_at,locale) VALUES($1,'Owner',$2,now(),now(),'de')",
        [user, `${user}@example.test`],
      );
      await owner.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",
        [randomUUID(), recent, user],
      );
      const notices = async () =>
        (
          await owner.query<{ kind: string; state: string }>(
            'SELECT kind,state FROM workspace_closure_mail WHERE tenant_id=$1 ORDER BY created_at,kind',
            [recent],
          )
        ).rows;
      await retention.pass();
      await retention.pass();
      expect(await notices()).toEqual([
        { kind: 'closure_scheduled', state: 'queued' },
      ]);
      await expect(
        worker.query('SELECT * FROM workspace_closure_mail'),
      ).rejects.toThrow(/permission denied/);

      const reserved = (
        await identity.query('SELECT * FROM reserve_workspace_closure_mail()')
      ).rows[0];
      expect(reserved).toMatchObject({
        kind: 'closure_scheduled',
        state: 'queued',
        attempts: 1,
        email: `${user}@example.test`,
        locale: 'de',
        workspace: 'Workspace',
        valid: true,
      });
      await identity.query('SELECT record_workspace_closure_mail($1,$2,$3,0)', [
        reserved.id,
        reserved.attempts,
        'sent',
      ]);
      // Retrying a recorded attempt changes nothing.
      await identity.query('SELECT record_workspace_closure_mail($1,$2,$3,0)', [
        reserved.id,
        reserved.attempts,
        'failed',
      ]);

      // A week before the date, the reminder follows the earlier notice once.
      const soon = new Date(Date.now() + 5 * 86_400_000);
      // As if the workspace had closed 85 days ago with a 90-day window.
      await owner.query(
        "UPDATE organizations SET data_deletion_at=$2,closed_at=$2::timestamptz-interval '90 days' WHERE id=$1",
        [recent, soon],
      );
      await owner.query(
        "UPDATE workspace_closure_mail SET deletion_at=$2,created_at=now()-interval '30 days' WHERE tenant_id=$1",
        [recent, soon],
      );
      await retention.pass();
      await retention.pass();
      expect(await notices()).toEqual([
        { kind: 'closure_scheduled', state: 'sent' },
        { kind: 'closure_reminder', state: 'queued' },
      ]);

      // Reopening clears the date, so the queued reminder is cancelled at delivery.
      await owner.query(
        "UPDATE organizations SET status='active' WHERE id=$1",
        [recent],
      );
      const reminder = (
        await identity.query('SELECT * FROM reserve_workspace_closure_mail()')
      ).rows[0];
      expect(reminder).toMatchObject({
        kind: 'closure_reminder',
        valid: false,
      });
      await identity.query('SELECT record_workspace_closure_mail($1,$2,$3,0)', [
        reminder.id,
        reminder.attempts,
        'cancelled',
      ]);
      expect((await notices()).map((notice) => notice.state)).toEqual([
        'sent',
        'cancelled',
      ]);
      expect(
        (
          await owner.query(
            'SELECT closed_at,data_deletion_at FROM organizations WHERE id=$1',
            [recent],
          )
        ).rows[0],
      ).toEqual({ closed_at: null, data_deletion_at: null });
    });

    it('reports open Shopify privacy requests due within a week, once an hour', async () => {
      const intake = '00000000-0000-4000-8000-000000000000';
      for (const [due, completed] of [
        ['3 days', false],
        ['-1 day', false],
        ['20 days', false],
        ['1 day', true],
      ] as const)
        await owner.query(
          `INSERT INTO shopify_privacy_requests(tenant_id,app,event_key,topic,payload,due_at,completed_at,evidence)
          VALUES($1,$2,$3,'customers/redact',$4,now()+$5::interval,$6,$7)`,
          [
            intake,
            app,
            randomUUID(),
            completed ? null : 'sealed',
            due,
            completed ? new Date() : null,
            completed ? 'ticket' : null,
          ],
        );
      // The first pass ran before these requests existed; an hour later they are reported.
      clock = new Date(clock.getTime() + 61 * 60_000);
      await retention.pass();
      await retention.pass();
      expect(logged.filter((l) => l.message.includes('privacy'))).toEqual([
        {
          message:
            'Shopify privacy requests are due within 7 days; complete them with the privacy tool.',
          detail: '2 open, 1 overdue',
        },
      ]);
      await expect(
        worker.query('SELECT payload FROM shopify_privacy_requests'),
      ).rejects.toThrow(/permission denied/);
    });

    it('classifies every tenant table and refuses to purge while one is unclassified', async () => {
      expect(
        (await owner.query('SELECT * FROM data_retention_unclassified()')).rows,
      ).toEqual([]);
      // Every class names a table that exists.
      expect(
        (
          await owner.query(
            "SELECT table_name FROM data_retention_classes WHERE to_regclass('public.'||table_name) IS NULL",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await owner.query(
            "SELECT class FROM data_retention_classes WHERE table_name='audit_entries'",
          )
        ).rows,
      ).toEqual([{ class: 'legal_retention' }]);

      await owner.query('CREATE TABLE retention_probe(tenant_id uuid)');
      try {
        const before = await rows(active);
        expect(
          (
            await owner.query(
              "SELECT * FROM purge_scoped_rows($1,NULL,100,'{}')",
              [active],
            )
          ).rows,
        ).toEqual([
          { deleted: 0, done: false, blocked: 'unclassified:retention_probe' },
        ]);
        expect(await rows(active)).toEqual(before);
      } finally {
        await owner.query('DROP TABLE retention_probe');
      }
    });
  },
);
