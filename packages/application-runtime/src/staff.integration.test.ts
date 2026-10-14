import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { promisify } from 'node:util';

import { AccountDisabledError } from '@luma/identity';
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
      await owner.query('SELECT luma_provision_cell_region($1)', ['AU']);
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
            'staff.accounts.inspect',
          ],
        },
        adminUrl,
      );
      await owner.query(
        "INSERT INTO users(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Customer Alice','alice@example.test',true,now(),now())",
        [customer],
      );
      await owner.query(
        "INSERT INTO organizations(id,name,slug,status,data_region,created_at) VALUES($1,'Workspace Alpha','alpha','active','AU',now()),($2,'Workspace Beta','beta','suspended','AU',now())",
        [tenantA, tenantB],
      );
      await owner.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",
        [randomUUID(), tenantA, customer],
      );
      await owner.query(
        "INSERT INTO sessions(id,token,user_id,expires_at,created_at,updated_at,ip_address,user_agent,last_active_at) VALUES($1,$2,$3,now()+interval '1 day',now(),now(),'192.0.2.40',$4,now())",
        [
          randomUUID(),
          randomUUID(),
          customer,
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        ],
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
            dataRegion: 'AU',
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
    it('denies and audits staff outside this cell before directory, grants or commands', async () => {
      await owner.query(
        "UPDATE staff_access SET regions=ARRAY['EU'] WHERE email='support@example.test'",
      );
      try {
        for (const request of [
          { url: '/v1/staff/directory?query=alice', headers: { cookie } },
          {
            method: 'POST' as const,
            url: `/v1/staff/workspaces/${tenantA}/access`,
            headers: { cookie, origin },
            payload: { reason: 'Customer requested investigation' },
          },
          {
            method: 'POST' as const,
            url: `/v1/staff/accounts/${customer}/access`,
            headers: { cookie, origin },
            payload: { reason: 'Customer requested investigation' },
          },
        ])
          expect((await app.inject(request)).statusCode).toBe(403);
        expect(
          (
            await owner.query(
              "SELECT event FROM staff_audit WHERE event='staff.region.denied'",
            )
          ).rowCount,
        ).toBe(3);
      } finally {
        await owner.query(
          "UPDATE staff_access SET regions=ARRAY['AU'] WHERE email='support@example.test'",
        );
      }
    });
    it('rechecks target placement inside privileged support SQL even with a retained grant', async () => {
      const target = randomUUID();
      const grant = randomUUID();
      const session = (
        await owner.query<{ id: string; user_id: string }>(
          "SELECT s.id,s.user_id FROM staff_sessions s JOIN staff_users u ON u.id=s.user_id WHERE u.email='support@example.test' ORDER BY s.created_at DESC LIMIT 1",
        )
      ).rows[0]!;
      await owner.query(
        "INSERT INTO organizations(id,name,slug,data_region,status,created_at) VALUES($1::uuid,'Other cell',$1::uuid::text,'EU','active',now())",
        [target],
      );
      await owner.query(
        "INSERT INTO staff_support_grants(id,staff_user_id,staff_session_id,tenant_id,reason,expires_at) VALUES($1,$2,$3,$4,'Retained regional support grant',now()+interval '30 minutes')",
        [grant, session.user_id, session.id, target],
      );
      const tx = await runtime.connect();
      try {
        await tx.query('BEGIN');
        await tx.query(
          "SELECT set_config('staff.user_id',$1,true),set_config('staff.session_id',$2,true),set_config('staff.grant_id',$3,true)",
          [session.user_id, session.id, grant],
        );
        expect(
          (
            await tx.query<{ allowed: boolean }>(
              'SELECT staff_has_workspace_access($1) AS allowed',
              [target],
            )
          ).rows[0]!.allowed,
        ).toBe(false);
        await expect(
          tx.query('SELECT identity_support_revoke_sessions($1,$2,$3,$4,$5)', [
            randomUUID(),
            target,
            customer,
            'Customer requested investigation',
            'regional-sql-test',
          ]),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await tx.query('ROLLBACK');
        tx.release();
        await owner.query('DELETE FROM staff_support_grants WHERE id=$1', [
          grant,
        ]);
        await owner.query('DELETE FROM organizations WHERE id=$1', [target]);
      }
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
          "UPDATE staff_access SET permissions=ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.accounts.inspect'] WHERE email='support@example.test'",
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
    it('restricts account data to the listed columns behind an account grant', async () => {
      for (const statement of [
        'SELECT created_at FROM users',
        'SELECT user_agent FROM sessions',
        'SELECT secret FROM two_factors',
        'SELECT credential_id FROM passkeys',
        'SELECT custom_role_id FROM memberships',
      ])
        await expect(runtime.query(statement)).rejects.toMatchObject({
          code: '42501',
        });
      const columns = async (view: string) =>
        (await runtime.query(`SELECT * FROM ${view} LIMIT 0`)).fields
          .map((field) => field.name)
          .sort();
      expect(await columns('staff_account_profile')).toEqual([
        'created_at',
        'deletion_erase_after',
        'deletion_erase_requested_at',
        'deletion_id',
        'deletion_reason_category',
        'deletion_reference',
        'deletion_scheduled_at',
        'deletion_scheduled_by_name',
        'disabled_at',
        'disabled_by_name',
        'disabled_reason',
        'disabled_reason_category',
        'email',
        'id',
        'name',
        'passkey_count',
        'two_factor_enabled',
      ]);
      expect(await columns('staff_account_sessions')).toEqual([
        'created_at',
        'expires_at',
        'id',
        'ip_address',
        'last_active_at',
        'user_agent',
        'user_id',
      ]);
      expect(await columns('staff_account_workspaces')).toEqual([
        'custom_role_name',
        'data_region',
        'id',
        'joined_at',
        'membership_status',
        'name',
        'role',
        'slug',
        'status',
        'user_id',
      ]);
      for (const view of [
        'staff_account_profile',
        'staff_account_sessions',
        'staff_account_workspaces',
      ])
        expect((await runtime.query(`SELECT FROM ${view}`)).rowCount).toBe(0);
    });
    it('opens audited account access and shows workspaces, factors and sessions', async () => {
      const tenantC = randomUUID();
      const roleId = randomUUID();
      await owner.query(
        "INSERT INTO organizations(id,name,slug,status,data_region,created_at) VALUES($1,'Workspace Gamma','gamma','active','AU',now())",
        [tenantC],
      );
      await owner.query(
        "INSERT INTO workspace_roles(tenant_id,id,name,created_by) VALUES($1,$2,'Buyer',$3)",
        [tenantC, roleId, customer],
      );
      await owner.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role,custom_role_id,created_at) VALUES($1,$2,$3,'custom',$4,now())",
        [randomUUID(), tenantC, customer, roleId],
      );
      await owner.query(
        "INSERT INTO passkeys(id,user_id,name,credential_id,public_key,counter,device_type,backed_up) VALUES($1,$2,'Laptop','secret-credential-id','secret-public-key',0,'singleDevice',false)",
        [randomUUID(), customer],
      );
      await owner.query(
        'UPDATE users SET two_factor_enabled=true WHERE id=$1',
        [customer],
      );
      const foreign = await owner.query<{ id: string }>(
        "SELECT id FROM users WHERE email='bob@example.test'",
      );
      const bob = foreign.rows[0]!.id;
      const url = `/v1/staff/accounts/${customer}`;
      expect(
        (
          await app.inject({
            url: `${url}?grantId=${randomUUID()}`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${url}/access`,
            headers: { cookie, origin },
            payload: { reason: 'short' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/staff/accounts/${randomUUID()}/access`,
            headers: { cookie, origin },
            payload: { reason: 'Investigating a missing customer account' },
          })
        ).statusCode,
      ).toBe(404);
      const opened = await app.inject({
        method: 'POST',
        url: `${url}/access`,
        headers: { cookie, origin },
        payload: { reason: 'Investigating a customer sign-in ticket' },
      });
      expect(opened.statusCode, opened.body).toBe(201);
      const accountGrant = opened.json().id as string;
      const detail = await app.inject({
        url: `${url}?grantId=${accountGrant}`,
        headers: { cookie },
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        account: { id: customer, email: 'alice@example.test' },
        security: { twoFactorEnabled: true, passkeys: 1 },
        workspacesTruncated: false,
        workspaces: [
          {
            id: tenantA,
            role: 'owner',
            customRoleName: null,
            membershipStatus: 'active',
          },
          {
            id: tenantC,
            role: 'custom',
            customRoleName: 'Buyer',
            membershipStatus: 'active',
          },
        ],
        sessions: [
          {
            ipAddress: '192.0.2.40',
            browser: 'Chrome 141',
            os: 'macOS',
            lastActiveAt: expect.any(String),
          },
        ],
      });
      expect(detail.body).not.toContain('secret-credential-id');
      expect(detail.body).not.toContain('token');
      for (const denied of [
        `/v1/staff/accounts/${bob}?grantId=${accountGrant}`,
        `/v1/staff/workspaces/${tenantA}?grantId=${accountGrant}`,
      ])
        expect(
          (await app.inject({ url: denied, headers: { cookie } })).statusCode,
        ).toBe(403);
      const evidence = await owner.query<{
        event: string;
        reason: string | null;
        details: { grantId: string; userId: string };
      }>(
        "SELECT event,reason,details FROM staff_audit WHERE event IN ('account.access.opened','account.inspected') ORDER BY sequence",
      );
      expect(evidence.rows).toEqual([
        {
          event: 'account.access.opened',
          reason: 'Investigating a customer sign-in ticket',
          details: { grantId: accountGrant, userId: customer },
        },
        {
          event: 'account.inspected',
          reason: null,
          details: { grantId: accountGrant, userId: customer },
        },
      ]);
      await owner.query(
        "UPDATE staff_access SET permissions=ARRAY['staff.directory.read','staff.workspace.inspect'] WHERE email='support@example.test'",
      );
      try {
        expect(
          (
            await app.inject({
              url: `${url}?grantId=${accountGrant}`,
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(403);
      } finally {
        await owner.query(
          "UPDATE staff_access SET permissions=ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.accounts.inspect'] WHERE email='support@example.test'",
        );
      }
      await owner.query(
        "UPDATE staff_account_grants SET expires_at=now()-interval '1 second' WHERE id=$1",
        [accountGrant],
      );
      expect(
        (
          await app.inject({
            url: `${url}?grantId=${accountGrant}`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(403);
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
      const events = await owner.query<{
        event_type: string;
        staff_command_id: string;
        request_id: string;
      }>(
        'SELECT event_type,staff_command_id,request_id FROM account_security_events WHERE user_id=$1',
        [customer],
      );
      expect(events.rows).toEqual([
        {
          event_type: 'sessions.revoked-by-staff',
          staff_command_id: commandId,
          request_id: response.headers['x-request-id'] ?? expect.any(String),
        },
      ]);
    });
    it('suspends and reactivates one membership with receipts, evidence and last-owner acknowledgement', async () => {
      const bob = (
        await owner.query<{ id: string }>(
          "SELECT id FROM users WHERE email='bob@example.test'",
        )
      ).rows[0]!.id;
      await owner.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'admin',now())",
        [randomUUID(), tenantA, bob],
      );
      const credentials = { cookie: customerCookie };
      expect(
        (await identity.service.resolveTenant(credentials, tenantA, 'before'))
          .actor.role.key,
      ).toBe('admin');
      const membershipUrl = (user: string, action: string) =>
        `/v1/staff/workspaces/${tenantA}/users/${user}/${action}-membership`;
      const change = (
        user: string,
        action: 'suspend' | 'reactivate',
        payload: Record<string, unknown>,
      ) =>
        app.inject({
          method: 'POST',
          url: membershipUrl(user, action),
          headers: { cookie, origin },
          payload: { grantId, ...payload },
        });
      const suspension = {
        reason: 'Departed employee, owner unreachable, ticket 4411',
        commandId: randomUUID(),
      };
      expect((await change(bob, 'suspend', suspension)).statusCode).toBe(403);

      await owner.query(
        "UPDATE staff_access SET permissions=ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.accounts.inspect','staff.memberships.manage'] WHERE email='support@example.test'",
      );
      try {
        const suspended = await change(bob, 'suspend', suspension);
        expect(suspended.statusCode, suspended.body).toBe(200);
        expect(suspended.json()).toMatchObject({
          commandId: suspension.commandId,
          status: 'suspended',
          lastActiveOwner: false,
        });
        // An exact retry returns the original receipt; other requests can't reuse the ID.
        expect((await change(bob, 'suspend', suspension)).json()).toEqual(
          suspended.json(),
        );
        for (const reuse of [
          change(bob, 'suspend', {
            ...suspension,
            reason: 'A different reason for the same command',
          }),
          change(bob, 'reactivate', suspension),
          change(customer, 'suspend', suspension),
        ])
          expect((await reuse).statusCode).toBe(409);
        const revoked = (
          await owner.query<{ command_id: string }>(
            'SELECT command_id FROM identity_support_commands LIMIT 1',
          )
        ).rows[0]!.command_id;
        expect(
          (await change(bob, 'suspend', { ...suspension, commandId: revoked }))
            .statusCode,
        ).toBe(409);
        expect(
          (
            await change(bob, 'suspend', {
              ...suspension,
              commandId: randomUUID(),
            })
          ).json().message,
        ).toMatch(/already suspended/);

        // The member is rejected on the next request; the account and its listing remain.
        await expect(
          identity.service.resolveTenant(credentials, tenantA, 'suspended'),
        ).rejects.toMatchObject({ statusCode: 403, code: 'ACCESS_SUSPENDED' });
        await expect(
          identity.service.resolveWorkflowContext(bob, tenantA, 'workflow'),
        ).rejects.toMatchObject({ code: 'ACCESS_SUSPENDED' });
        const ownerContext = await identity.service.resolveWorkflowContext(
          customer,
          tenantA,
          'owner-read',
        );
        expect(
          await identity.service.suspendedMembers(ownerContext, [
            bob,
            customer,
            'operator',
          ]),
        ).toEqual(new Set([bob]));
        expect(
          await identity.service.listOrganizations(credentials, 'list'),
        ).toEqual([
          expect.objectContaining({
            id: tenantA,
            membershipStatus: 'suspended',
          }),
        ]);
        const detail = await app.inject({
          url: `/v1/staff/workspaces/${tenantA}?grantId=${grantId}`,
          headers: { cookie },
        });
        expect(
          detail
            .json()
            .members.find((m: { userId: string }) => m.userId === bob),
        ).toMatchObject({
          status: 'suspended',
          suspendedBy: 'staff',
          suspendedAt: expect.any(String),
        });
        const events = await owner.query(
          "SELECT actor_id,actor_kind,event_type,target_id,before_value,after_value FROM workspace_access_events WHERE tenant_id=$1 AND event_type LIKE 'member.%' ORDER BY created_at",
          [tenantA],
        );
        expect(events.rows).toEqual([
          {
            actor_id: '00000000-0000-0000-0000-000000000000',
            actor_kind: 'staff',
            event_type: 'member.suspended',
            target_id: expect.any(String),
            before_value: expect.objectContaining({
              userId: bob,
              roleId: 'admin',
              roleName: 'Admin',
              status: 'active',
            }),
            after_value: expect.objectContaining({ status: 'suspended' }),
          },
        ]);
        const audit = await owner.query(
          "SELECT tenant_id,reason,details FROM staff_audit WHERE event='customer.membership.suspended'",
        );
        expect(audit.rows).toEqual([
          {
            tenant_id: tenantA,
            reason: suspension.reason,
            details: expect.objectContaining({
              commandId: suspension.commandId,
              userId: bob,
              lastActiveOwner: false,
            }),
          },
        ]);

        // The only active owner needs an explicit acknowledgement.
        const owners = {
          reason: 'Customer asked for urgent removal of this owner',
          commandId: randomUUID(),
        };
        const refused = await change(customer, 'suspend', owners);
        expect(refused.statusCode).toBe(409);
        expect(refused.json().message).toMatch(/only active owner/);
        const acknowledged = await change(customer, 'suspend', {
          ...owners,
          commandId: randomUUID(),
          acknowledgeLastOwner: true,
        });
        expect(acknowledged.statusCode, acknowledged.body).toBe(200);
        expect(acknowledged.json().lastActiveOwner).toBe(true);

        // Reactivation restores the same role.
        const reactivated = await change(bob, 'reactivate', {
          reason: 'Access dispute resolved with the workspace',
          commandId: randomUUID(),
        });
        expect(reactivated.statusCode, reactivated.body).toBe(200);
        expect(reactivated.json().status).toBe('active');
        expect(
          (await identity.service.resolveTenant(credentials, tenantA, 'after'))
            .actor.role.key,
        ).toBe('admin');
        expect(
          (
            await change(customer, 'reactivate', {
              reason: 'Owner access restored after verification',
              commandId: randomUUID(),
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await owner.query(
              "SELECT event FROM staff_audit WHERE event LIKE 'customer.membership.%' ORDER BY sequence",
            )
          ).rows.map((row) => row.event),
        ).toEqual([
          'customer.membership.suspended',
          'customer.membership.suspended',
          'customer.membership.reactivated',
          'customer.membership.reactivated',
        ]);
        const history = await app.inject({
          url: `/v1/staff/workspaces/${tenantA}/access-history?grantId=${grantId}`,
          headers: { cookie },
        });
        expect(history.json().events[0]).toMatchObject({
          type: 'member.reactivated',
          actor: { name: 'Luma support', member: null },
        });
        // Another workspace's grant can't change this membership.
        const other = await app.inject({
          method: 'POST',
          url: `/v1/staff/workspaces/${tenantB}/users/${bob}/suspend-membership`,
          headers: { cookie, origin },
          payload: { ...suspension, grantId, commandId: randomUUID() },
        });
        expect(other.statusCode).toBe(403);
      } finally {
        await owner.query(
          "UPDATE staff_access SET permissions=ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.accounts.inspect'] WHERE email='support@example.test'",
        );
        await owner.query(
          'DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',
          [tenantA, bob],
        );
        // Later access history assertions count their own seeded events.
        await owner.query(
          "DELETE FROM workspace_access_events WHERE tenant_id=$1 AND actor_kind='staff'",
          [tenantA],
        );
      }
    });
    it('disables and enables an account everywhere with a receipt, evidence and refused sign-ins', async () => {
      const bob = (
        await owner.query<{ id: string }>(
          "SELECT id FROM users WHERE email='bob@example.test'",
        )
      ).rows[0]!.id;
      await owner.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'admin',now())",
        [randomUUID(), tenantA, bob],
      );
      const customerOrigin = 'http://localhost:3209';
      const signIn = () =>
        identity.handler(
          new Request(`${customerOrigin}/auth/sign-in/email`, {
            method: 'POST',
            headers: {
              origin: customerOrigin,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email: 'bob@example.test',
              password: 'customer-test-password-long-enough',
            }),
          }),
        );
      const credentials = { cookie: customerCookie };
      expect(
        (await identity.service.resolveTenant(credentials, tenantA, 'before'))
          .actor.role.key,
      ).toBe('admin');
      const accountGrant = await app.inject({
        method: 'POST',
        url: `/v1/staff/accounts/${bob}/access`,
        headers: { cookie, origin },
        payload: { reason: 'Compromise report from the workspace owner' },
      });
      expect(accountGrant.statusCode, accountGrant.body).toBe(201);
      const accountGrantId: string = accountGrant.json().id;
      const change = (
        action: 'disable' | 'enable',
        payload: Record<string, unknown>,
      ) =>
        app.inject({
          method: 'POST',
          url: `/v1/staff/accounts/${bob}/${action}`,
          headers: { cookie, origin },
          payload: { grantId: accountGrantId, ...payload },
        });
      const disabling = {
        category: 'compromised',
        reason: 'Credentials posted publicly, ticket 5120',
        commandId: randomUUID(),
        acknowledgeGlobalEffect: true,
      };
      expect((await change('disable', disabling)).statusCode).toBe(403);

      await owner.query(
        "UPDATE staff_access SET permissions=ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.accounts.inspect','staff.accounts.manage'] WHERE email='support@example.test'",
      );
      try {
        expect(
          (
            await change('disable', {
              ...disabling,
              acknowledgeGlobalEffect: undefined,
            })
          ).statusCode,
        ).toBe(400);
        const disabled = await change('disable', disabling);
        expect(disabled.statusCode, disabled.body).toBe(200);
        expect(disabled.json()).toMatchObject({
          commandId: disabling.commandId,
          status: 'disabled',
          revokedSessions: 1,
        });
        // An exact retry returns the original receipt; other requests can't reuse the ID.
        expect((await change('disable', disabling)).json()).toEqual(
          disabled.json(),
        );
        const revoked = (
          await owner.query<{ command_id: string }>(
            'SELECT command_id FROM identity_support_commands LIMIT 1',
          )
        ).rows[0]!.command_id;
        for (const reuse of [
          change('disable', { ...disabling, category: 'abuse' }),
          change('enable', {
            reason: disabling.reason,
            commandId: disabling.commandId,
          }),
          change('disable', { ...disabling, commandId: revoked }),
        ])
          expect((await reuse).statusCode).toBe(409);
        expect(
          (
            await change('disable', { ...disabling, commandId: randomUUID() })
          ).json().message,
        ).toMatch(/already disabled/);

        // The deleted session is rejected and new sign-ins are refused, without a session.
        await expect(
          identity.service.resolveTenant(credentials, tenantA, 'disabled'),
        ).rejects.toMatchObject({ statusCode: 401 });
        const refused = await signIn();
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({
          code: 'ACCOUNT_DISABLED',
          message:
            'This account is disabled. Contact your workspace owner or Luma support.',
        });
        expect(
          (await owner.query('SELECT 1 FROM sessions WHERE user_id=$1', [bob]))
            .rowCount,
        ).toBe(0);

        // Background re-checks reject the person and other owners see the work needs a new owner.
        await expect(
          identity.service.resolveWorkflowContext(bob, tenantA, 'workflow'),
        ).rejects.toBeInstanceOf(AccountDisabledError);
        const ownerContext = await identity.service.resolveWorkflowContext(
          customer,
          tenantA,
          'owner-read',
        );
        expect(
          await identity.service.suspendedMembers(ownerContext, [
            bob,
            customer,
          ]),
        ).toEqual(new Set([bob]));

        const account = await app.inject({
          url: `/v1/staff/accounts/${bob}?grantId=${accountGrantId}`,
          headers: { cookie },
        });
        expect(account.json().disabled).toEqual({
          at: expect.any(String),
          category: 'compromised',
          reason: disabling.reason,
          byName: 'Support operator',
        });
        expect(account.json().sessions).toEqual([]);
        const workspace = await app.inject({
          url: `/v1/staff/workspaces/${tenantA}?grantId=${grantId}`,
          headers: { cookie },
        });
        expect(
          workspace
            .json()
            .members.map(
              (member: {
                userId: string;
                onlyWorkspace: boolean;
                accountDisabled: boolean;
              }) => [
                member.userId,
                member.onlyWorkspace,
                member.accountDisabled,
              ],
            ),
        ).toEqual(
          expect.arrayContaining([
            [bob, true, true],
            [customer, false, false],
          ]),
        );
        const audit = await owner.query(
          "SELECT tenant_id,reason,details FROM staff_audit WHERE event='customer.account.disabled'",
        );
        expect(audit.rows).toEqual([
          {
            tenant_id: null,
            reason: disabling.reason,
            details: expect.objectContaining({
              commandId: disabling.commandId,
              userId: bob,
              reasonCategory: 'compromised',
              revokedSessions: 1,
            }),
          },
        ]);

        // Enabling restores sign-in and the previous workspace with its role.
        const enabling = {
          reason: 'Password reset confirmed by the account holder',
          commandId: randomUUID(),
        };
        const enabled = await change('enable', enabling);
        expect(enabled.statusCode, enabled.body).toBe(200);
        expect(enabled.json()).toMatchObject({
          status: 'enabled',
          revokedSessions: 0,
        });
        expect((await change('enable', enabling)).json()).toEqual(
          enabled.json(),
        );
        expect(
          (
            await change('enable', { ...enabling, commandId: randomUUID() })
          ).json().message,
        ).toMatch(/already enabled/);
        const signedIn = await signIn();
        expect(signedIn.status).toBe(200);
        customerCookie = signedIn.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        expect(
          (
            await identity.service.resolveTenant(
              { cookie: customerCookie },
              tenantA,
              'after',
            )
          ).actor.role.key,
        ).toBe('admin');
        const events = await owner.query(
          "SELECT event_type,outcome,reason_code,staff_command_id FROM account_security_events WHERE user_id=$1 AND (event_type LIKE 'account.%' OR reason_code='account-disabled') ORDER BY created_at",
          [bob],
        );
        expect(events.rows).toEqual([
          {
            event_type: 'account.disabled',
            outcome: 'succeeded',
            reason_code: null,
            staff_command_id: disabling.commandId,
          },
          {
            event_type: 'sign-in.password',
            outcome: 'failed',
            reason_code: 'account-disabled',
            staff_command_id: null,
          },
          {
            event_type: 'account.enabled',
            outcome: 'succeeded',
            reason_code: null,
            staff_command_id: enabling.commandId,
          },
        ]);
      } finally {
        await owner.query(
          "UPDATE staff_access SET permissions=ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.accounts.inspect'] WHERE email='support@example.test'",
        );
        await owner.query('DELETE FROM account_disablements WHERE user_id=$1', [
          bob,
        ]);
        await owner.query(
          'DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',
          [tenantA, bob],
        );
      }
    });
    it('pages an account’s security events under an account grant and audits each page', async () => {
      const url = `/v1/staff/accounts/${customer}/security-events`;
      const opened = await app.inject({
        method: 'POST',
        url: `/v1/staff/accounts/${customer}/access`,
        headers: { cookie, origin },
        payload: { reason: 'Reviewing recent account security activity' },
      });
      expect(opened.statusCode, opened.body).toBe(201);
      const accountGrant = opened.json().id as string;
      for (const denied of [grantId, randomUUID()])
        expect(
          (
            await app.inject({
              url: `${url}?grantId=${denied}`,
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(403);
      for (let index = 0; index < 26; index++)
        await owner.query(
          "INSERT INTO account_security_events(id,user_id,event_type,outcome,reason_code,request_id,ip_address,user_agent,created_at) VALUES($1,$2,'sign-in.password','failed','invalid-credentials','seed','192.0.2.50','Mozilla/5.0 (Windows NT 10.0) Firefox/143.0',now()-make_interval(hours=>$3))",
          [randomUUID(), customer, index + 1],
        );
      const first = await app.inject({
        url: `${url}?grantId=${accountGrant}`,
        headers: { cookie },
      });
      expect(first.statusCode, first.body).toBe(200);
      const page = first.json();
      expect(page.items).toHaveLength(25);
      expect(page.items[0]).toMatchObject({
        type: 'sessions.revoked-by-staff',
        staffCommandId: expect.any(String),
      });
      expect(page.items[1]).toMatchObject({
        type: 'sign-in.password',
        outcome: 'failed',
        reason: 'invalid-credentials',
        ipAddress: '192.0.2.50',
        browser: 'Firefox 143',
        os: 'Windows',
      });
      expect(first.body).not.toContain('email_hash');
      const next = await app.inject({
        url: `${url}?grantId=${accountGrant}&cursor=${page.nextCursor}`,
        headers: { cookie },
      });
      expect(next.json().items).toHaveLength(2);
      expect(next.json().nextCursor).toBeNull();
      expect(
        (
          await app.inject({
            url: `${url}?grantId=${accountGrant}&cursor=invalid`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(400);
      const audits = await owner.query<{
        details: { grantId: string; events: number };
      }>(
        "SELECT details FROM staff_audit WHERE event='account.security-events.inspected' ORDER BY sequence",
      );
      expect(audits.rows.map((row) => row.details.events)).toEqual([25, 2]);
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
        'luma_cell_region.provisioned_at',
        'luma_cell_region.region',
        'luma_cell_region.singleton',
        'memberships.id',
        'memberships.role',
        'memberships.status',
        'memberships.suspended_at',
        'memberships.suspended_by_kind',
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
        // The account page shows the inspected account's own email under its account grant.
        if (row.relname === 'staff_account_profile' && row.attname === 'email')
          continue;
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
    it('lets only audit readers page filtered staff audit entries, and never modify them', async () => {
      const denied = await app.inject({
        url: '/v1/staff/audit',
        headers: { cookie },
      });
      expect(denied.statusCode, denied.body).toBe(403);
      await expect(
        runtime.query(
          'SELECT * FROM staff_audit_entries(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,10)',
        ),
      ).rejects.toMatchObject({ code: '42501' });
      for (const statement of [
        'SELECT event FROM staff_audit',
        'UPDATE staff_audit SET reason=NULL',
        'DELETE FROM staff_audit',
        'TRUNCATE staff_audit',
      ])
        await expect(runtime.query(statement)).rejects.toMatchObject({
          code: '42501',
        });
      const staffUser = (
        await owner.query<{ id: string }>(
          "SELECT id FROM staff_users WHERE email='support@example.test'",
        )
      ).rows[0]!.id;
      await owner.query(
        `INSERT INTO staff_audit(staff_user_id,tenant_id,event,request_id,details,created_at)
        SELECT CASE WHEN n%10=0 THEN $1::uuid END,CASE WHEN n%3=0 THEN $2::uuid END,
         (ARRAY['directory.searched','workspace.inspected','workspace.health.read'])[1+n%3],'seed-'||n,'{}',
         now()-interval '1 day'-make_interval(secs=>n)
        FROM generate_series(1,100000) n`,
        [staffUser, tenantB],
      );
      await owner.query(
        "INSERT INTO staff_audit(event,request_id,details) VALUES('staff.sign-in.failed','seed-failed','{\"method\":\"local\"}')",
      );
      await owner.query('ANALYZE staff_audit');
      await owner.query(
        "UPDATE staff_access SET permissions=array_append(permissions,'staff.audit.read') WHERE email='support@example.test'",
      );
      try {
        const read = (query: string) =>
          app.inject({ url: `/v1/staff/audit${query}`, headers: { cookie } });
        const started = Date.now();
        const revocations = await read(
          `?account=${customer}&event=customer.sessions.revoked`,
        );
        expect(revocations.statusCode, revocations.body).toBe(200);
        expect(revocations.json().entries).toEqual([
          expect.objectContaining({
            event: 'customer.sessions.revoked',
            outcome: 'succeeded',
            reason: 'Customer requested all sessions to be revoked',
            requestId: expect.any(String),
            staff: {
              id: staffUser,
              name: 'Support operator',
              email: 'support@example.test',
            },
            workspace: { id: tenantA, name: 'Workspace Alpha' },
            account: {
              id: customer,
              name: 'Customer Alice',
              email: 'alice@example.test',
            },
          }),
        ]);
        const byEmail = await read('?account=alice@example.test');
        expect(
          byEmail.json().entries.map((entry: { event: string }) => entry.event),
        ).toContain('customer.sessions.revoked');
        const range = new URLSearchParams({
          staff: 'support@example.test',
          workspace: tenantB,
          from: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          to: new Date(Date.now() - 86_400_000).toISOString(),
        });
        const first = await read(`?${range}`);
        expect(first.statusCode, first.body).toBe(200);
        const page = first.json();
        expect(page.entries).toHaveLength(50);
        expect(page.nextCursor).toEqual(expect.any(String));
        const second = await read(
          `?${range}&cursor=${encodeURIComponent(page.nextCursor)}`,
        );
        const older = second.json().entries;
        expect(older).toHaveLength(50);
        for (const entry of [...page.entries, ...older]) {
          expect(entry.workspace.id).toBe(tenantB);
          expect(entry.staff.email).toBe('support@example.test');
        }
        expect(
          new Set(
            [...page.entries, ...older].map(
              (entry: { sequence: string }) => entry.sequence,
            ),
          ).size,
        ).toBe(100);
        expect(Date.parse(older[0].createdAt)).toBeLessThanOrEqual(
          Date.parse(page.entries.at(-1).createdAt),
        );
        const failed = await read('?event=staff.sign-in.failed');
        expect(failed.json().entries[0]).toMatchObject({
          outcome: 'failed',
          staff: null,
        });
        expect(
          (await read('?staff=nobody@example.test')).json().entries,
        ).toEqual([]);
        expect(Date.now() - started).toBeLessThan(5000);
        const audited = await owner.query<{
          details: { filters: Record<string, string>; entries: number };
        }>(
          "SELECT details FROM staff_audit WHERE event='staff.audit.read' AND staff_user_id=$1 ORDER BY sequence",
          [staffUser],
        );
        expect(audited.rows).toHaveLength(6);
        expect(audited.rows[0]?.details).toMatchObject({
          filters: { account: customer, event: 'customer.sessions.revoked' },
          entries: 1,
        });
      } finally {
        await owner.query(
          "UPDATE staff_access SET permissions=array_remove(permissions,'staff.audit.read') WHERE email='support@example.test'",
        );
        await owner.query(
          "DELETE FROM staff_audit WHERE request_id LIKE 'seed-%'",
        );
      }
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
    it('clears security event network details after 90 days and deletes events after a year', async () => {
      // The customer identity runtime applies retention with its restricted login.
      const day = 86_400_000;
      const id = randomUUID();
      await owner.query(
        "INSERT INTO account_security_events(id,user_id,event_type,outcome,request_id,ip_address,user_agent) VALUES($1,$2,'sign-in.password','succeeded','retention','192.0.2.9','Retention agent')",
        [id, customer],
      );
      const read = async () =>
        (
          await owner.query(
            'SELECT ip_address,user_agent FROM account_security_events WHERE id=$1',
            [id],
          )
        ).rows[0];
      const at = (days: number) => new Date(Date.now() + days * day);
      await identity.purgeSecurityEvents(at(89));
      expect(await read()).toEqual({
        ip_address: '192.0.2.9',
        user_agent: 'Retention agent',
      });
      await identity.purgeSecurityEvents(at(91));
      expect(await read()).toEqual({ ip_address: null, user_agent: null });
      await identity.purgeSecurityEvents(at(364));
      expect(await read()).toBeDefined();
      await identity.purgeSecurityEvents(at(366));
      expect(await read()).toBeUndefined();
    });
  },
);
