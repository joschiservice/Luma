import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { promisify } from 'node:util';

import { createIdentity } from '@luma/identity/composition';
import {
  createStaff,
  provisionStaffIdentity,
  readStaffSettings,
  seedLocalStaff,
} from '@luma/staff/composition';
import { registerStaffHttp } from '@luma/staff/http';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'staff API with restricted PostgreSQL credentials',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const database = `luma_staff_test_${suffix}`;
    const login = `luma_staff_test_${suffix}`;
    const customerLogin = `luma_customer_test_${suffix}`;
    const password = randomUUID();
    const admin = new Pool({ connectionString: databaseUrl });
    let owner: Pool;
    let runtime: Pool;
    let staff: ReturnType<typeof createStaff>;
    let settings: ReturnType<typeof readStaffSettings>;
    let identity: ReturnType<typeof createIdentity>;
    let app: ReturnType<typeof Fastify>;
    let cookie: string;
    let customerCookie: string;
    const origin = 'http://localhost:3210';
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const customer = randomUUID();
    let grantId: string;
    beforeAll(async () => {
      await admin.query(`CREATE DATABASE "${database}"`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${database}`;
      owner = new Pool({ connectionString: url.toString() });
      const setup = await admin.connect();
      try {
        await setup.query(
          "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
        );
        await promisify(execFile)(
          process.execPath,
          [new URL('../scripts/migrate.mjs', import.meta.url).pathname],
          { env: { ...process.env, MIGRATION_DATABASE_URL: url.toString() } },
        );
      } finally {
        await setup.query(
          "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
        );
        setup.release();
      }
      await admin.query(
        `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(`GRANT luma_staff_runtime TO "${login}"`);
      await admin.query(
        `CREATE ROLE "${customerLogin}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(`GRANT luma_identity TO "${customerLogin}"`);
      const adminUrl = url.toString();
      url.username = login;
      url.password = password;
      settings = readStaffSettings({
        NODE_ENV: 'test',
        STAFF_DATABASE_URL: url.toString(),
        STAFF_PUBLIC_ORIGIN: origin,
        STAFF_AUTH_SECRET: 'integration-staff-secret-at-least-32-characters',
        STAFF_AUTH_MODE: 'local',
        STAFF_API_PORT: '3211',
        STAFF_COOKIE_PREFIX: 'integration-staff',
      });
      await seedLocalStaff(
        settings,
        {
          name: 'Support operator',
          email: 'support@example.test',
          password: 'staff-test-password-long-enough',
          permissions: [
            'staff.directory.read',
            'staff.workspace.inspect',
            'staff.sessions.revoke',
          ],
        },
        adminUrl,
      );
      await owner.query(
        "INSERT INTO users(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Customer Alice','alice@example.test',true,now(),now())",
        [customer],
      );
      await owner.query(
        "INSERT INTO organizations(id,name,slug,status,data_region,created_at) VALUES($1,'Workspace Alpha','alpha','active','EU',now()),($2,'Workspace Beta','beta','suspended','EU',now())",
        [tenantA, tenantB],
      );
      await owner.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",
        [randomUUID(), tenantA, customer],
      );
      await owner.query(
        "INSERT INTO sessions(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,now()+interval '1 day',now(),now())",
        [randomUUID(), randomUUID(), customer],
      );
      runtime = new Pool({ connectionString: url.toString() });
      staff = createStaff(settings);
      app = Fastify();
      registerStaffHttp(app, staff);
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/auth/sign-in/email',
        headers: { origin },
        payload: {
          email: 'support@example.test',
          password: 'staff-test-password-long-enough',
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ success: true });
      const cookies = response.headers['set-cookie'];
      cookie = (Array.isArray(cookies) ? cookies : [cookies])
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.split(';')[0])
        .join('; ');
      const customerUrl = new URL(adminUrl);
      customerUrl.username = customerLogin;
      customerUrl.password = password;
      const customerOrigin = 'http://localhost:3209';
      identity = createIdentity({
        databaseUrl: customerUrl.toString(),
        secret: 'separate-customer-secret-at-least-32-characters',
        baseURL: customerOrigin,
        trustedOrigins: [customerOrigin],
        cookiePrefix: 'integration-customer',
      });
      const customerResponse = await identity.handler(
        new Request(`${customerOrigin}/auth/sign-up/email`, {
          method: 'POST',
          headers: {
            origin: customerOrigin,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Customer Bob',
            email: 'bob@example.test',
            password: 'customer-test-password-long-enough',
          }),
        }),
      );
      expect(customerResponse.status).toBe(200);
      customerCookie = customerResponse.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const customerSession = await identity.handler(
        new Request(`${customerOrigin}/auth/get-session`, {
          headers: { cookie: customerCookie },
        }),
      );
      expect(customerSession.status).toBe(200);
      expect(await customerSession.json()).toMatchObject({
        user: { email: 'bob@example.test' },
      });
    }, 60000);
    afterAll(async () => {
      await app?.close();
      await staff?.close();
      await identity?.close();
      await runtime?.end();
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.query(`DROP ROLE IF EXISTS "${login}"`);
      await admin.query(`DROP ROLE IF EXISTS "${customerLogin}"`);
      await admin.end();
    });
    it('checks role restrictions and rejects raw customer/session/registry mutations', async () => {
      expect(await staff.checkReadiness()).toBe(true);
      await expect(
        runtime.query('SELECT token FROM sessions'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtime.query('UPDATE staff_access SET active=false'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtime.query('UPDATE connector_installations SET secret=NULL'),
      ).rejects.toMatchObject({ code: '42501' });
    });
    it('rejects readiness when runtime credentials gain customer roles or raw provider documents', async () => {
      await admin.query(`GRANT luma_orders TO "${login}"`);
      try {
        expect(await staff.checkReadiness()).toBe(false);
      } finally {
        await admin.query(`REVOKE luma_orders FROM "${login}"`);
      }
      await owner.query(
        `GRANT SELECT(document) ON connector_installations TO "${login}"`,
      );
      try {
        expect(await staff.checkReadiness()).toBe(false);
      } finally {
        await owner.query(
          `REVOKE SELECT(document) ON connector_installations FROM "${login}"`,
        );
      }
      expect(await staff.checkReadiness()).toBe(true);
    });
    it('denies customer routes, public signup, unauthenticated access and forged origins', async () => {
      for (const request of [
        { method: 'GET' as const, url: '/v1/staff/directory?query=Alice' },
        {
          method: 'POST' as const,
          url: '/auth/sign-up/email',
          headers: { origin },
          payload: {},
        },
        {
          method: 'GET' as const,
          url: '/v1/organizations',
          headers: { cookie },
        },
        {
          method: 'POST' as const,
          url: `/v1/staff/workspaces/${tenantA}/access`,
          headers: { cookie, origin: 'http://attacker.example' },
          payload: { reason: 'Customer support investigation' },
        },
      ]) {
        const response = await app.inject(request);
        expect([401, 403, 404]).toContain(response.statusCode);
      }
    });
    it('rejects authenticated customer cookies even when renamed to the staff namespace', async () => {
      for (const forwarded of [
        customerCookie,
        customerCookie.replaceAll(
          'integration-customer.',
          'integration-staff.',
        ),
      ]) {
        const response = await app.inject({
          url: '/v1/staff/session',
          headers: { cookie: forwarded },
        });
        expect(response.statusCode, response.body).toBe(401);
      }
      const deniedMutation = await app.inject({
        method: 'POST',
        url: `/v1/staff/workspaces/${tenantA}/access`,
        headers: { cookie: customerCookie, origin },
        payload: { reason: 'Customer must not create staff support access' },
      });
      expect(deniedMutation.statusCode, deniedMutation.body).toBe(401);
    });
    it('finds workspaces through customer identity without exposing credentials', async () => {
      const response = await app.inject({
        url: '/v1/staff/directory?query=alice@example.test',
        headers: { cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().workspaces).toEqual([
        expect.objectContaining({ id: tenantA }),
      ]);
      expect(response.body).not.toContain('token');
    });
    it('rechecks the specific directory privilege after a permission change', async () => {
      const session = await staff.resolveSession(
        new Headers({ cookie }),
        randomUUID(),
      );
      await owner.query(
        "UPDATE staff_access SET permissions=ARRAY['staff.workspace.inspect','staff.sessions.revoke'] WHERE email='support@example.test'",
      );
      try {
        await expect(
          staff.service.directory(session.context, 'Alice'),
        ).rejects.toMatchObject({ status: 403 });
      } finally {
        await owner.query(
          "UPDATE staff_access SET permissions=ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke'] WHERE email='support@example.test'",
        );
      }
    });
    it('requires a reason and scopes workspace access to the operator session and tenant', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/staff/workspaces/${tenantA}/access`,
        headers: { cookie, origin },
        payload: { reason: 'Investigating the customer access ticket' },
      });
      expect(response.statusCode, response.body).toBe(201);
      grantId = response.json().id;
      expect(
        (
          await app.inject({
            url: `/v1/staff/workspaces/${tenantB}?grantId=${grantId}`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(403);
      const detail = await app.inject({
        url: `/v1/staff/workspaces/${tenantA}?grantId=${grantId}`,
        headers: { cookie },
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().members[0].userId).toBe(customer);
    });
    it('rolls back session deletion and the command receipt if audit insertion fails', async () => {
      const commandId = randomUUID();
      await owner.query(
        `CREATE FUNCTION reject_customer_revocation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='customer.sessions.revoked' THEN RAISE EXCEPTION 'audit store unavailable'; END IF; RETURN NEW; END $$`,
      );
      await owner.query(
        'CREATE TRIGGER reject_customer_revocation_audit BEFORE INSERT ON staff_audit FOR EACH ROW EXECUTE FUNCTION reject_customer_revocation_audit()',
      );
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/staff/workspaces/${tenantA}/users/${customer}/revoke-sessions`,
          headers: { cookie, origin },
          payload: {
            grantId,
            reason: 'Customer requested account session revocation',
            commandId,
            acknowledgeGlobalEffect: true,
          },
        });
        expect(response.statusCode, response.body).toBe(503);
        expect(response.body).not.toContain('audit store unavailable');
        expect(
          (
            await owner.query('SELECT FROM sessions WHERE user_id=$1', [
              customer,
            ])
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await owner.query(
              'SELECT FROM identity_support_commands WHERE command_id=$1',
              [commandId],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await owner.query(
              "SELECT FROM staff_audit WHERE event='customer.sessions.revoked' AND details->>'commandId'=$1",
              [commandId],
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        await owner.query(
          'DROP TRIGGER reject_customer_revocation_audit ON staff_audit',
        );
        await owner.query('DROP FUNCTION reject_customer_revocation_audit()');
      }
    });
    it('atomically revokes global sessions with a durable receipt and rejects command reuse', async () => {
      const commandId = randomUUID();
      const input = {
        grantId,
        reason: 'Customer requested all sessions to be revoked',
        commandId,
        acknowledgeGlobalEffect: true,
      };
      const request = {
        method: 'POST' as const,
        url: `/v1/staff/workspaces/${tenantA}/users/${customer}/revoke-sessions`,
        headers: { cookie, origin },
        payload: input,
      };
      const response = await app.inject(request);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().revokedSessions).toBe(1);
      const repeat = await app.inject(request);
      expect(repeat.json()).toEqual(response.json());
      const conflict = await app.inject({
        ...request,
        payload: {
          ...input,
          reason: 'Different customer support request reason',
        },
      });
      expect(conflict.statusCode, conflict.body).toBe(409);
      expect(
        (await owner.query('SELECT FROM sessions WHERE user_id=$1', [customer]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await owner.query(
            "SELECT FROM staff_audit WHERE event='customer.sessions.revoked'",
          )
        ).rowCount,
      ).toBe(1);
    });
    it('exposes only allowlisted customer columns and metadata views to the staff runtime', async () => {
      const columns = await runtime.query<{ relname: string; attname: string }>(
        `SELECT c.relname,a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
        AND left(c.relname,6)<>'staff_' AND has_column_privilege(current_user,c.oid,a.attnum,'SELECT')
        ORDER BY 1,2`,
      );
      expect(
        columns.rows.map((row) => `${row.relname}.${row.attname}`),
      ).toEqual([
        'memberships.id',
        'memberships.role',
        'memberships.tenant_id',
        'memberships.user_id',
        'organizations.data_region',
        'organizations.id',
        'organizations.name',
        'organizations.slug',
        'organizations.status',
        'users.email',
        'users.id',
        'users.name',
      ]);
      const views = await runtime.query<{ relname: string; attname: string }>(
        `SELECT c.relname,a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='v' AND a.attnum>0
        AND has_column_privilege(current_user,c.oid,a.attnum,'SELECT')`,
      );
      expect(views.rows.length).toBeGreaterThan(0);
      for (const row of views.rows) {
        expect(row.relname).toMatch(/^staff_/);
        expect(row.attname).not.toMatch(
          /^(document|secret|payload|token|password|credentials|target|manifest|before_value|after_value|values|email|request|result)$/,
        );
      }
      await expect(
        runtime.query('SELECT error_message FROM commerce_sync_streams'),
      ).rejects.toMatchObject({ code: '42501' });
      expect(
        (await runtime.query('SELECT * FROM staff_health_sync_streams'))
          .rowCount,
      ).toBe(0);
    });
    it('reads bounded workspace health and access history under a current grant without payloads', async () => {
      const connection = randomUUID();
      const otherConnection = randomUUID();
      const stream = randomUUID();
      const proposal = randomUUID();
      const failedRun = randomUUID();
      const pendingRun = randomUUID();
      const fingerprint = 'f'.repeat(64);
      const seed = await owner.connect();
      try {
        await seed.query('BEGIN');
        // Owner triggers and foreign keys are disabled: these rows only exercise staff reads.
        await seed.query('SET LOCAL session_replication_role=replica');
        const installation = (tenant: string, id: string) =>
          seed.query(
            'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
            [
              tenant,
              id,
              {
                id,
                tenantId: tenant,
                version: 1,
                provider: 'shopify',
                status: 'active',
                credentialVersion: 3,
                target: { kind: 'shopify', shop: 'private-target.example' },
                granted: ['orders.read', 'products.read'],
              },
              'private-credential-secret',
            ],
          );
        await installation(tenantA, connection);
        await installation(tenantB, otherConnection);
        await seed.query(
          `INSERT INTO commerce_sync_streams(tenant_id,id,connection_id,record_type,principal_id,phase,attempts,error_code,error_message,error_at,failing_since)
          VALUES($1,$2,$3,'orders',$4,'incremental',3,'authentication','The provider rejected the connection credentials.',now(),now()-interval '1 hour'),
          ($5,$6,$7,'orders',$4,'incremental',1,'tenant_b_error','Other workspace',now(),now())`,
          [
            tenantA,
            stream,
            connection,
            customer,
            tenantB,
            randomUUID(),
            otherConnection,
          ],
        );
        await seed.query(
          `INSERT INTO commerce_sync_runs(tenant_id,id,stream_id,kind,trigger,full_scan,started_at,outcome,records,failed,errors)
          VALUES($1,$2,$3,'incremental','schedule',false,now(),'completed',10,2,1)`,
          [tenantA, randomUUID(), stream],
        );
        await seed.query(
          `INSERT INTO connector_read_checks(tenant_id,connection_id,capability,observed_at,succeeded,document)
          VALUES($1,$2,'orders.read',now(),false,$3),($1,$2,'products.read',now(),true,$4)`,
          [
            tenantA,
            connection,
            { ok: false, error: { code: 'authentication' } },
            {
              ok: true,
              value: {
                items: [{ email: 'shopper-observation@example.test' }],
              },
            },
          ],
        );
        await seed.query(
          "INSERT INTO connector_lifecycle_events(tenant_id,connection_id,version,event,actor_id,status,credential_version) VALUES($1,$2,1,'connected',$3,'active',3)",
          [tenantA, connection, customer],
        );
        await seed.query(
          "INSERT INTO executed_actions(id,tenant_id,proposal_id,idempotency_key,action_hash,state,document) VALUES($1,$2,$3,$4,$5,'failed',$6)",
          [
            randomUUID(),
            tenantA,
            proposal,
            `v0:${proposal}`,
            'a'.repeat(64),
            {
              state: 'failed',
              tenantId: tenantA,
              proposalId: proposal,
              intent: {
                capability: 'inventory.available.reconcile',
                connectionId: connection,
                parameters: { sku: 'PRIVATE-ORDER-PARAMETER' },
              },
              attempt: { dispatch: 'dispatched', businessOutcome: 'pending' },
            },
          ],
        );
        await seed.query(
          'INSERT INTO execution_failures(tenant_id,id,proposal_id,document) VALUES($1,$2,$3,$4)',
          [
            tenantA,
            randomUUID(),
            proposal,
            {
              phase: 'dispatch',
              code: 'timeout',
              retry: 'reconcile',
              effect: 'unknown',
              providerRequestId: 'private-provider-request',
            },
          ],
        );
        for (const run of [failedRun, pendingRun])
          await seed.query(
            `INSERT INTO workflow_trigger_runs(tenant_id,id,definition_id,version,version_digest,dedupe_key,request_digest,document,state,triggered_at)
            VALUES($1,$2,'restock','1','digest',$4,'request',$3,'awaiting_admission',now()-interval '2 hours')`,
            [
              tenantA,
              run,
              {
                tenantId: tenantA,
                id: run,
                definitionId: 'restock',
                version: '1',
                versionDigest: 'digest',
                requestDigest: 'request',
                trigger: { kind: 'event' },
              },
              run,
            ],
          );
        await seed.query(
          "INSERT INTO workflow_process_steps(tenant_id,run_id,step_id,state,document) VALUES($1,$2,'notify','failed',$3)",
          [
            tenantA,
            failedRun,
            {
              stepId: 'notify',
              state: 'failed',
              kind: 'notify',
              recordedAt: new Date().toISOString(),
              values: { note: 'PRIVATE-STEP-VALUE' },
            },
          ],
        );
        const activation = randomUUID();
        await seed.query(
          "INSERT INTO workflow_case_activations(tenant_id,id,definition_id,principal_id,document,created_at) VALUES($1,$2,'shopify.hold',$3,$4,now())",
          [
            tenantA,
            activation,
            customer,
            {
              id: activation,
              definitionId: 'shopify.hold',
              principalId: customer,
            },
          ],
        );
        const exception = randomUUID();
        await seed.query(
          "INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,'awaiting_approval',$4)",
          [
            exception,
            tenantA,
            fingerprint,
            {
              id: exception,
              tenantId: tenantA,
              state: 'awaiting_approval',
              fingerprint,
              occurrenceCount: 1,
              exceptionClass: 'sync_failure',
              severity: 'high',
            },
          ],
        );
        await seed.query(
          'INSERT INTO exception_uncertainty(tenant_id,fingerprint,first_deferred_at,review_required) VALUES($1,$2,now(),true)',
          [tenantA, fingerprint],
        );
        await seed.query(
          "INSERT INTO workspace_mail(tenant_id,id,event_key,kind,user_id,state,attempts) VALUES($1,$2,'failed-mail','issues',$3,'failed',5)",
          [tenantA, randomUUID(), customer],
        );
        await seed.query(
          "INSERT INTO workspace_apps(tenant_id,app_id,status,version,manifest) VALUES($1,'shopify','installed',2,$2)",
          [tenantA, { version: '1.4.0', permissions: [], scopes: [] }],
        );
        await seed.query(
          "INSERT INTO workspace_settings(tenant_id,timezone,always_require_approval) VALUES($1,'Europe/Berlin',true)",
          [tenantA],
        );
        await seed.query(
          `INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id,before_value,after_value,created_at)
          SELECT gen_random_uuid(),$1,$2,'member.update',$3,$4,$5,now()-make_interval(mins=>n) FROM generate_series(1,55) n`,
          [
            tenantA,
            customer,
            randomUUID(),
            { userId: customer, roleName: 'Member' },
            {
              userId: customer,
              roleName: 'Admin',
              email: 'private-invitee@example.test',
            },
          ],
        );
        await seed.query('COMMIT');
      } catch (error) {
        await seed.query('ROLLBACK');
        throw error;
      } finally {
        seed.release();
      }
      const opened = await app.inject({
        method: 'POST',
        url: `/v1/staff/workspaces/${tenantA}/access`,
        headers: { cookie, origin },
        payload: { reason: 'Investigating a failing order sync' },
      });
      expect(opened.statusCode, opened.body).toBe(201);
      const grant = opened.json().id;
      const health = await app.inject({
        url: `/v1/staff/workspaces/${tenantA}/health?grantId=${grant}`,
        headers: { cookie },
      });
      expect(health.statusCode, health.body).toBe(200);
      for (const hidden of [
        'private-credential-secret',
        'private-target.example',
        'shopper-observation@example.test',
        'PRIVATE-ORDER-PARAMETER',
        'private-provider-request',
        'PRIVATE-STEP-VALUE',
        'tenant_b_error',
      ])
        expect(health.body).not.toContain(hidden);
      const body = health.json();
      expect(body.settings).toEqual({
        timezone: 'Europe/Berlin',
        alwaysRequireApproval: true,
      });
      expect(body.sync.streams).toEqual([
        expect.objectContaining({
          id: stream,
          attempts: 3,
          errorCode: 'authentication',
          failingSince: expect.any(String),
        }),
      ]);
      expect(body.sync.runs[0]).toMatchObject({ failed: 2, errors: 1 });
      expect(body.connections.items).toEqual([
        {
          id: connection,
          provider: 'shopify',
          status: 'active',
          version: 1,
          credentialVersion: 3,
        },
      ]);
      expect(body.connections.events[0].actor).toEqual({
        id: customer,
        name: 'Customer Alice',
        member: true,
      });
      expect(body.connections.readChecks).toEqual([
        expect.objectContaining({
          capability: 'orders.read',
          succeeded: false,
          errorCode: 'authentication',
        }),
        expect.objectContaining({
          capability: 'products.read',
          succeeded: true,
          errorCode: null,
        }),
      ]);
      expect(body.execution.failed).toEqual({ count: 1, capped: false });
      expect(body.execution.actions[0]).toMatchObject({
        capability: 'inventory.available.reconcile',
        connectionId: connection,
      });
      expect(body.execution.failures[0]).toMatchObject({
        phase: 'dispatch',
        code: 'timeout',
      });
      expect(body.workflows.steps).toEqual([
        expect.objectContaining({ runId: failedRun, state: 'failed' }),
      ]);
      expect(body.workflows.awaitingAdmission).toMatchObject({
        count: 1,
        capped: false,
      });
      expect(body.workflows.activations[0].principal.name).toBe(
        'Customer Alice',
      );
      expect(body.cases).toEqual({
        open: 1,
        byState: [{ state: 'awaiting_approval', count: 1 }],
        awaitingApproval: 1,
        reviewRequired: 1,
      });
      expect(body.mail.failed).toEqual({ count: 1, capped: false });
      expect(body.apps).toEqual([
        expect.objectContaining({ appId: 'shopify', appVersion: '1.4.0' }),
      ]);
      const first = await app.inject({
        url: `/v1/staff/workspaces/${tenantA}/access-history?grantId=${grant}`,
        headers: { cookie },
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.body).not.toContain('private-invitee@example.test');
      const page = first.json();
      expect(page.events).toHaveLength(50);
      expect(page.events[0]).toMatchObject({
        type: 'member.update',
        summary: 'Member → Admin',
        actor: { id: customer, name: 'Customer Alice', member: true },
        subject: { id: customer, name: 'Customer Alice' },
      });
      const second = await app.inject({
        url: `/v1/staff/workspaces/${tenantA}/access-history?grantId=${grant}&cursor=${page.nextCursor}`,
        headers: { cookie },
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().events).toHaveLength(5);
      expect(second.json().nextCursor).toBeNull();
      expect(
        new Set(
          [...page.events, ...second.json().events].map(
            (event: { id: string }) => event.id,
          ),
        ).size,
      ).toBe(55);
      const audit = await owner.query<{ event: string; count: number }>(
        "SELECT event,count(*)::int AS count FROM staff_audit WHERE tenant_id=$1 AND event IN ('workspace.health.read','workspace.access-history.read') AND details->>'grantId'=$2 GROUP BY event ORDER BY event",
        [tenantA, grant],
      );
      expect(audit.rows).toEqual([
        { event: 'workspace.access-history.read', count: 2 },
        { event: 'workspace.health.read', count: 1 },
      ]);
      for (const path of ['health', 'access-history'])
        expect(
          (
            await app.inject({
              url: `/v1/staff/workspaces/${tenantB}/${path}?grantId=${grant}`,
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(403);
      await owner.query(
        "UPDATE staff_support_grants SET expires_at=now()-interval '1 second' WHERE id=$1",
        [grant],
      );
      for (const path of ['health', 'access-history'])
        expect(
          (
            await app.inject({
              url: `/v1/staff/workspaces/${tenantA}/${path}?grantId=${grant}`,
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(403);
    });
    it('expires passive polling while extending idle time only for activity before expiry', async () => {
      const session = await owner.query<{ id: string }>(
        'SELECT s.id FROM staff_sessions s JOIN staff_users u ON u.id=s.user_id WHERE u.email=$1',
        ['support@example.test'],
      );
      const sessionId = session.rows[0]?.id;
      if (!sessionId) throw new Error('Staff session unavailable.');
      const before = new Date(Date.now() - 29 * 60_000);
      await owner.query('UPDATE staff_sessions SET updated_at=$1 WHERE id=$2', [
        before,
        sessionId,
      ]);
      const readTime = async () => {
        const result = await owner.query<{ updated_at: Date }>(
          'SELECT updated_at FROM staff_sessions WHERE id=$1',
          [sessionId],
        );

        return result.rows[0]?.updated_at.getTime();
      };
      for (let attempt = 0; attempt < 3; attempt++)
        expect(
          (await app.inject({ url: '/v1/staff/session', headers: { cookie } }))
            .statusCode,
        ).toBe(200);
      expect(await readTime()).toBe(before.getTime());
      expect(
        (
          await app.inject({
            url: '/v1/staff/session',
            headers: { cookie, 'x-luma-staff-activity': 'true' },
          })
        ).statusCode,
      ).toBe(200);
      expect(await readTime()).toBeGreaterThan(before.getTime());
      const expired = new Date(Date.now() - 31 * 60_000);
      await owner.query('UPDATE staff_sessions SET updated_at=$1 WHERE id=$2', [
        expired,
        sessionId,
      ]);
      expect(
        (
          await app.inject({
            url: '/v1/staff/session',
            headers: { cookie, 'x-luma-staff-activity': 'true' },
          })
        ).statusCode,
      ).toBe(403);
      expect(await readTime()).toBe(expired.getTime());
      await owner.query(
        'UPDATE staff_sessions SET updated_at=now() WHERE id=$1',
        [sessionId],
      );
    });
    it('honors expiration and immediate operator revocation, and local setup preserves revocation', async () => {
      await owner.query(
        "UPDATE staff_support_grants SET expires_at=now()-interval '1 second' WHERE id=$1",
        [grantId],
      );
      expect(
        (
          await app.inject({
            url: `/v1/staff/workspaces/${tenantA}?grantId=${grantId}`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(403);
      await owner.query(
        "UPDATE staff_access SET active=false WHERE email='support@example.test'",
      );
      expect(
        (await app.inject({ url: '/v1/staff/session', headers: { cookie } }))
          .statusCode,
      ).toBe(403);
    });
    it('rejects remote effective administrator destinations before local seeding connects', async () => {
      await expect(
        seedLocalStaff(
          settings,
          {
            email: 'guard@example.test',
            name: 'Guard',
            password: 'local-password-long-enough',
            permissions: ['staff.directory.read'],
          },
          'postgresql://administrator:password@localhost/test?host=db.example.com',
        ),
      ).rejects.toThrow('effective loopback');
    });
    it('invalidates persisted staff sessions permanently on offboarding, permission changes and subject rebinding', async () => {
      const administrator = new URL(databaseUrl!);
      administrator.pathname = `/${database}`;
      const email = 'rotation@example.test';
      const principal = {
        email,
        subject: 'verified-google-subject-before-rotation',
        active: true,
        permissions: [
          'staff.directory.read',
          'staff.workspace.inspect',
          'staff.sessions.revoke',
        ] as const,
        operator: 'workspace-administrator',
        reason: 'Reviewing explicit workforce access assignments',
      };
      await seedLocalStaff(
        settings,
        {
          name: 'Rotating support operator',
          email,
          password: 'rotating-staff-password-long-enough',
          permissions: [...principal.permissions],
        },
        administrator.toString(),
      );
      const provision = (
        changes: {
          active?: boolean;
          subject?: string;
          permissions?: (typeof principal.permissions)[number][];
        } = {},
      ) =>
        provisionStaffIdentity(administrator.toString(), {
          ...principal,
          permissions: [...principal.permissions],
          ...changes,
        });
      const createSession = async () => {
        const id = randomUUID();
        await owner.query(
          "INSERT INTO staff_sessions(id,token,user_id,provider_subject,expires_at,created_at,updated_at) SELECT $1,$2,id,$3,now()+interval '1 hour',now(),now() FROM staff_users WHERE email=$4",
          [id, randomUUID(), principal.subject, email],
        );

        return id;
      };
      const count = async (id: string) =>
        (await owner.query('SELECT FROM staff_sessions WHERE id=$1', [id]))
          .rowCount;
      await provision();
      const first = await createSession();
      expect(await count(first)).toBe(1);
      await provision({ active: false });
      expect(await count(first)).toBe(0);
      await provision({ active: true });
      expect(await count(first)).toBe(0);
      const permission = await createSession();
      await provision({ permissions: ['staff.directory.read'] });
      expect(await count(permission)).toBe(0);
      const subject = await createSession();
      await provision({
        subject: 'verified-google-subject-after-rotation',
        permissions: ['staff.directory.read'],
      });
      expect(await count(subject)).toBe(0);
      const evidence = await owner.query<{
        details: { email: string; active: boolean; operator: string };
      }>(
        "SELECT details FROM staff_audit WHERE event='staff.identity.provisioned' AND details->>'email'=$1 ORDER BY sequence",
        [email],
      );
      expect(evidence.rows).toHaveLength(5);
      expect(evidence.rows[1]?.details).toMatchObject({
        email,
        active: false,
        operator: principal.operator,
      });
    });
    it('rebinds a Google subject explicitly without automatic account linking and rolls back conflicts', async () => {
      const issuer = 'https://accounts.google.com';
      const clientId = 'staff-rebind-client';
      const origin = 'https://staff.example.test';
      const email = 'google-rebind@example.test';
      const beforeSubject = 'google-subject-before';
      const afterSubject = 'google-subject-after';
      const administrator = new URL(databaseUrl!);
      administrator.pathname = `/${database}`;
      const principal = {
        email,
        subject: beforeSubject,
        active: true,
        permissions: ['staff.directory.read'] as const,
        operator: 'workspace-administrator',
        reason: 'Approved explicit Google identity subject rebinding',
      };
      const provision = (subject: string) =>
        provisionStaffIdentity(administrator.toString(), {
          ...principal,
          subject,
          permissions: [...principal.permissions],
        });
      const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });
      const jwk = {
        ...publicKey.export({ format: 'jwk' }),
        kid: suffix,
        alg: 'RS256',
        use: 'sig',
      };
      const codes = new Map<string, { nonce: string; subject: string }>();
      const providerFetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input, options) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.endsWith('/.well-known/openid-configuration'))
            return Response.json({
              issuer,
              authorization_endpoint: issuer + '/authorize',
              token_endpoint: issuer + '/test-token',
              jwks_uri: issuer + '/test-keys/' + suffix,
              id_token_signing_alg_values_supported: ['RS256'],
            });
          if (url === issuer + '/test-keys/' + suffix)
            return Response.json({ keys: [jwk] });
          if (url === issuer + '/test-token') {
            const code = new URLSearchParams(String(options?.body)).get('code');
            const transaction = codes.get(code ?? '');
            if (!transaction)
              throw new Error('Unknown synthetic authorization code.');
            codes.delete(code ?? '');
            const header = Buffer.from(
              JSON.stringify({ alg: 'RS256', kid: suffix }),
            ).toString('base64url');
            const now = Math.floor(Date.now() / 1000);
            const claims = Buffer.from(
              JSON.stringify({
                iss: issuer,
                aud: clientId,
                sub: transaction.subject,
                email,
                email_verified: true,
                hd: 'example.test',
                name: 'Google operator',
                nonce: transaction.nonce,
                iat: now,
                exp: now + 300,
              }),
            ).toString('base64url');
            const payload = header + '.' + claims;
            const jwt =
              payload +
              '.' +
              sign('RSA-SHA256', Buffer.from(payload), privateKey).toString(
                'base64url',
              );

            return Response.json({
              token_type: 'Bearer',
              access_token: 'synthetic-provider-token',
              id_token: jwt,
            });
          }
          throw new Error('Unexpected synthetic provider request.');
        });
      let google: ReturnType<typeof createStaff> | undefined;
      let googleApp: ReturnType<typeof Fastify> | undefined;
      try {
        await provision(beforeSubject);
        google = createStaff({
          ...settings,
          mode: 'google',
          publicOrigin: origin,
          googleClientId: clientId,
          googleClientSecret: 'synthetic-google-client-secret',
          googleHostedDomain: 'example.test',
          cookiePrefix: 'google-rebind',
        });
        googleApp = Fastify();
        registerStaffHttp(googleApp, google);
        await googleApp.ready();
        const app = googleApp;
        const cookies = (response: { headers: Record<string, unknown> }) => {
          const value = response.headers['set-cookie'];

          return (Array.isArray(value) ? value : [value])
            .filter((cookie): cookie is string => typeof cookie === 'string')
            .map((cookie) => cookie.split(';')[0])
            .join('; ');
        };
        let client = 1;
        const signIn = async (subject: string) => {
          const remoteAddress = '192.0.2.' + client++;
          const start = await app.inject({
            remoteAddress,
            method: 'POST',
            url: '/auth/sign-in/social',
            headers: { origin },
            payload: {
              provider: 'google',
              callbackURL: origin + '/workspaces',
              errorCallbackURL: origin + '/login?signInFailed=true',
            },
          });
          expect(start.statusCode, start.body).toBe(200);
          const authorization = new URL(start.json().url);
          const code = randomUUID();
          codes.set(code, {
            nonce: authorization.searchParams.get('nonce') ?? '',
            subject,
          });

          return app.inject({
            url:
              '/auth/callback/google?' +
              new URLSearchParams({
                code,
                state: authorization.searchParams.get('state') ?? '',
              }),
            headers: { cookie: cookies(start) },
            remoteAddress,
          });
        };
        const first = await signIn(beforeSubject);
        expect(first.headers.location).toBe(origin + '/workspaces');
        const firstCookie = cookies(first);
        const firstSession = await app.inject({
          url: '/v1/staff/session',
          headers: { cookie: firstCookie },
        });
        expect(firstSession.statusCode, firstSession.body).toBe(200);
        const userId = firstSession.json().user.id;
        const raceKey = Number.parseInt(suffix.slice(0, 7), 16);
        const blocker = await owner.connect();
        let staleResponse: Awaited<ReturnType<typeof signIn>> | undefined;
        let paused: ReturnType<typeof signIn> | undefined;
        try {
          await blocker.query('BEGIN');
          await blocker.query('SELECT pg_advisory_xact_lock($1)', [raceKey]);
          await owner.query(
            `CREATE FUNCTION pause_staff_subject_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.provider_subject='google-subject-before' THEN PERFORM pg_advisory_xact_lock(${raceKey}); END IF; RETURN NEW; END $$`,
          );
          await owner.query(
            'CREATE TRIGGER pause_staff_subject_session BEFORE INSERT ON staff_sessions FOR EACH ROW EXECUTE FUNCTION pause_staff_subject_session()',
          );
          paused = signIn(beforeSubject);
          await expect
            .poll(
              async () => {
                const result = await owner.query<{ waiting: boolean }>(
                  "SELECT EXISTS(SELECT FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=$1::oid) AS waiting",
                  [raceKey],
                );

                return result.rows[0]?.waiting;
              },
              { timeout: 5000 },
            )
            .toBe(true);
          await provision(afterSubject);
          await blocker.query('COMMIT');
          staleResponse = await paused;
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          await paused;
          await owner.query(
            'DROP TRIGGER IF EXISTS pause_staff_subject_session ON staff_sessions',
          );
          await owner.query(
            'DROP FUNCTION IF EXISTS pause_staff_subject_session()',
          );
        }
        if (!staleResponse)
          throw new Error('Paused callback did not complete.');
        expect(staleResponse.headers.location).toBe(origin + '/workspaces');
        const staleCookie = cookies(staleResponse);
        expect(
          (
            await app.inject({
              url: '/v1/staff/session',
              headers: { cookie: staleCookie },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              url: '/v1/staff/directory?query=google',
              headers: { cookie: staleCookie },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              url: '/v1/staff/session',
              headers: { cookie: firstCookie },
            })
          ).statusCode,
        ).toBe(401);
        const rejected = await signIn(beforeSubject);
        expect(rejected.headers.location).toContain('error=');
        expect(cookies(rejected)).not.toContain('session_token');
        const second = await signIn(afterSubject);
        expect(second.headers.location).toBe(origin + '/workspaces');
        const secondCookie = cookies(second);
        const secondSession = await app.inject({
          url: '/v1/staff/session',
          headers: { cookie: secondCookie },
        });
        expect(secondSession.statusCode, secondSession.body).toBe(200);
        expect(secondSession.json().user.id).toBe(userId);
        const collisionUser = randomUUID();
        const collisionSubject = 'google-subject-bound-to-another-user';
        await owner.query(
          'INSERT INTO staff_users(id,name,email,email_verified,created_at,updated_at) VALUES($1,$2,$3,true,now(),now())',
          [collisionUser, 'Other operator', 'other-google@example.test'],
        );
        await owner.query(
          "INSERT INTO staff_accounts(id,account_id,provider_id,user_id,created_at,updated_at) VALUES($1,$2,'google',$3,now(),now())",
          [randomUUID(), collisionSubject, collisionUser],
        );
        await expect(provision(collisionSubject)).rejects.toMatchObject({
          code: '23505',
        });
        expect(
          (
            await app.inject({
              url: '/v1/staff/session',
              headers: { cookie: secondCookie },
            })
          ).statusCode,
        ).toBe(200);
        const accounts = await owner.query<{ account_id: string }>(
          'SELECT account_id FROM staff_accounts WHERE user_id=$1',
          [userId],
        );
        expect(accounts.rows).toEqual([{ account_id: afterSubject }]);
        const grant = await owner.query<{ provider_subject: string }>(
          'SELECT provider_subject FROM staff_access WHERE email=$1',
          [email],
        );
        expect(grant.rows[0]?.provider_subject).toBe(afterSubject);
      } finally {
        await googleApp?.close();
        await google?.close();
        providerFetch.mockRestore();
      }
    });
  },
);
