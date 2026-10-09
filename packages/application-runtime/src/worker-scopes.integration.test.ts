import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

type Status = 'active' | 'suspended' | 'closed';

const scopeFunctions = [
  'detection_worker_scopes',
  'commerce_sync_scopes',
  'commerce_auto_link_scopes',
  'replenishment_worker_scopes',
  'case_workflow_worker_scopes',
  'code_process_worker_scopes',
  'procurement_submission_scopes',
] as const;

describe.skipIf(!databaseUrl)(
  'background discovery for suspended and closed workspaces',
  () => {
    const name = `scopes_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    const workspaces: Record<Status, string> = {
      active: randomUUID(),
      suspended: randomUUID(),
      closed: randomUUID(),
    };
    let owner: Pool;
    let worker: Pool;

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
        for (const file of (
          await readdir(new URL('../migrations/', import.meta.url))
        ).sort())
          if (file.endsWith('.sql'))
            await owner.query(
              await readFile(
                new URL(`../migrations/${file}`, import.meta.url),
                'utf8',
              ),
            );
      } finally {
        await setup.query(
          "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
        );
        setup.release();
      }
      // Discovery runs with the workers' restricted logins, never the owner's.
      const password = randomUUID();
      await admin.query(
        `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(
        `GRANT luma_desk,luma_exceptions,luma_commerce_sync TO "${name}"`,
      );
      url.username = name;
      url.password = password;
      worker = new Pool({ connectionString: url.toString() });

      for (const [status, id] of Object.entries(workspaces))
        await owner.query(
          'INSERT INTO organizations(id,name,slug,status,created_at) VALUES($1,$2,$3,$4,now())',
          [id, status, `${status}-${id}`, status],
        );
      const client = await owner.connect();
      try {
        // Discovery reads routing columns only, so fixtures skip the records behind them.
        await client.query("SET session_replication_role='replica'");
        for (const id of Object.values(workspaces)) await work(client, id);
      } finally {
        await client.query("SET session_replication_role='origin'");
        client.release();
      }
    });

    afterAll(async () => {
      await worker?.end();
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.query(`DROP ROLE IF EXISTS "${name}"`);
      await admin.end();
    });

    /** Gives one workspace due work for every discovery function. */
    async function work(client: PoolClient, tenant: string) {
      const [shop, erp] = [randomUUID(), randomUUID()];
      await client.query(
        `INSERT INTO commerce_sync_streams(tenant_id,id,connection_id,record_type,principal_id,phase,due_at)
        VALUES($1,$2,$3,'orders','operator','backfill',now()-interval '1 minute')`,
        [tenant, randomUUID(), shop],
      );
      await client.query(
        "INSERT INTO connector_refresh_hints(tenant_id,connection_id,event_key,capabilities) VALUES($1,$2,'orders/updated',ARRAY['orders.read'])",
        [tenant, shop],
      );
      await client.query(
        `INSERT INTO commerce_auto_link_rules(tenant_id,id,kind,target_connection_id,source_connection_id,revision,enabled,principal_id,state,due_at)
        VALUES($1,$2,'sku',$3,$4,1,true,'operator','active',now()-interval '1 minute')`,
        [tenant, randomUUID(), shop, erp],
      );
      const replenishment = randomUUID();
      const position = randomUUID();
      await client.query(
        'INSERT INTO replenishment_activations(tenant_id,id,position_id,principal_id,document,created_at) VALUES($1,$2,$3,$4,$5,now())',
        [
          tenant,
          replenishment,
          position,
          'operator',
          { id: replenishment, positionId: position, principalId: 'operator' },
        ],
      );
      const activation = randomUUID();
      await client.query(
        "INSERT INTO workflow_case_activations(tenant_id,id,definition_id,principal_id,document,created_at) VALUES($1,$2,'case-workflow','operator',$3,now())",
        [
          tenant,
          activation,
          {
            id: activation,
            definitionId: 'case-workflow',
            principalId: 'operator',
          },
        ],
      );
      const submission = randomUUID();
      const order = randomUUID();
      await client.query(
        "INSERT INTO procurement_submissions(tenant_id,id,purchase_order_id,connection_id,state,principal_id,document,created_at) VALUES($1,$2,$3,$4,'approved','operator',$5,now())",
        [
          tenant,
          submission,
          order,
          erp,
          { id: submission, tenantId: tenant, purchaseOrderId: order },
        ],
      );
      await version(client, tenant, 'compute', [{ kind: 'code' }]);
      await start(client, tenant, 'compute', { kind: 'manual' });
      await version(client, tenant, 'scheduled', [{ kind: 'end' }]);
    }

    const digest = (definition: string) =>
      definition === 'compute' ? 'c'.repeat(64) : 'e'.repeat(64);

    async function version(
      client: PoolClient | Pool,
      tenant: string,
      definition: string,
      steps: { kind: string }[],
    ) {
      await client.query(
        "INSERT INTO playbook_versions(tenant_id,definition_id,version,digest,document) VALUES($1,$2,'1',$3,$4)",
        [
          tenant,
          definition,
          digest(definition),
          {
            definition: { id: definition },
            version: '1',
            digest: digest(definition),
            format: 'workflow/2',
            steps,
          },
        ],
      );
    }

    /** Records a start: awaiting admission, or pending when it has a scheduled time. */
    async function start(
      client: PoolClient | Pool,
      tenant: string,
      definition: string,
      trigger: { kind: 'manual' } | { kind: 'schedule'; at: string },
    ) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO workflow_trigger_runs(tenant_id,id,definition_id,version,version_digest,dedupe_key,request_digest,document,state,due_at)
        VALUES($1,$2::uuid,$3,'1',$4,$2::text,'r',$5,$6,$7)`,
        [
          tenant,
          id,
          definition,
          digest(definition),
          {
            tenantId: tenant,
            id,
            definitionId: definition,
            version: '1',
            versionDigest: digest(definition),
            requestDigest: 'r',
            trigger,
            actor: { kind: 'user', id: 'operator' },
          },
          trigger.kind === 'schedule' ? 'scheduled' : 'awaiting_admission',
          trigger.kind === 'schedule' ? trigger.at : null,
        ],
      );

      return id;
    }

    async function startState(tenant: string, id: string) {
      return (
        await owner.query<{ state: string; triggered_at: Date | null }>(
          'SELECT state,triggered_at FROM workflow_trigger_runs WHERE tenant_id=$1 AND id=$2',
          [tenant, id],
        )
      ).rows[0];
    }

    it.each(scopeFunctions)(
      '%s returns active workspaces only',
      async (scope) => {
        const found = new Set(
          (
            await worker.query<{ tenant_id: string }>(
              `SELECT tenant_id FROM ${scope}()`,
            )
          ).rows.map((row) => row.tenant_id),
        );

        expect(found.has(workspaces.active)).toBe(true);
        expect(found.has(workspaces.suspended)).toBe(false);
        expect(found.has(workspaces.closed)).toBe(false);
      },
    );

    it('keeps discovery restricted to the workers that use it', async () => {
      const definitions = await owner.query<{
        name: string;
        definer: boolean;
        config: string[];
        public: boolean;
      }>(
        `SELECT p.proname AS name,p.prosecdef AS definer,p.proconfig AS config,
          p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) AS public
        FROM pg_proc p WHERE p.proname=ANY($1) ORDER BY p.proname`,
        [[...scopeFunctions, 'advance_workflow_schedules']],
      );

      expect(definitions.rows).toHaveLength(scopeFunctions.length + 1);
      for (const row of definitions.rows)
        expect(row, row.name).toMatchObject({
          definer: true,
          config: ['search_path=pg_catalog, public'],
          public: false,
        });
    });

    it('skips schedules that come due while a workspace is suspended and never fires them later', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const schedule = (tenant: string, at: string) =>
        start(owner, tenant, 'scheduled', { kind: 'schedule', at });
      const due: Record<Status, string> = {
        active: await schedule(workspaces.active, past),
        suspended: await schedule(workspaces.suspended, past),
        closed: await schedule(workspaces.closed, past),
      };
      const later = await schedule(workspaces.suspended, future);

      await worker.query('SELECT advance_workflow_schedules()');
      expect(await startState(workspaces.active, due.active)).toMatchObject({
        state: 'awaiting_admission',
        triggered_at: expect.any(Date),
      });
      for (const status of ['suspended', 'closed'] as const)
        expect(await startState(workspaces[status], due[status])).toEqual({
          state: 'skipped',
          triggered_at: null,
        });
      expect(await startState(workspaces.suspended, later)).toEqual({
        state: 'scheduled',
        triggered_at: null,
      });

      await owner.query(
        "UPDATE organizations SET status='active' WHERE id=$1",
        [workspaces.suspended],
      );
      try {
        await worker.query('SELECT advance_workflow_schedules()');
        expect(
          await startState(workspaces.suspended, due.suspended),
        ).toMatchObject({ state: 'skipped' });
        // A start that was not yet due during the suspension runs at its time.
        await owner.query(
          'UPDATE workflow_trigger_runs SET due_at=now() WHERE tenant_id=$1 AND id=$2',
          [workspaces.suspended, later],
        );
        await worker.query('SELECT advance_workflow_schedules()');
        expect(await startState(workspaces.suspended, later)).toMatchObject({
          state: 'awaiting_admission',
          triggered_at: expect.any(Date),
        });
      } finally {
        await owner.query(
          "UPDATE organizations SET status='suspended' WHERE id=$1",
          [workspaces.suspended],
        );
      }
    });
  },
);
