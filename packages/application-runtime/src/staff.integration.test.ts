import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
    it('invalidates staff sessions permanently on offboarding, permission changes and subject rebinding', async () => {
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
      const signIn = async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/sign-in/email',
          headers: { origin },
          payload: { email, password: 'rotating-staff-password-long-enough' },
        });
        expect(response.statusCode, response.body).toBe(200);
        const values = response.headers['set-cookie'];

        return (Array.isArray(values) ? values : [values])
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.split(';')[0])
          .join('; ');
      };
      const sessionStatus = async (value: string) =>
        (
          await app.inject({
            url: '/v1/staff/session',
            headers: { cookie: value },
          })
        ).statusCode;

      await provision();
      const firstCookie = await signIn();
      expect(await sessionStatus(firstCookie)).toBe(200);
      await provision({ active: false });
      expect(await sessionStatus(firstCookie)).toBe(401);
      await provision({ active: true });
      expect(await sessionStatus(firstCookie)).toBe(401);

      const permissionCookie = await signIn();
      expect(await sessionStatus(permissionCookie)).toBe(200);
      await provision({ permissions: ['staff.directory.read'] });
      expect(await sessionStatus(permissionCookie)).toBe(401);

      const subjectSessionId = randomUUID();
      await owner.query(
        "INSERT INTO staff_sessions(id,token,user_id,expires_at,created_at,updated_at) SELECT $1,$2,id,now()+interval '1 hour',now(),now() FROM staff_users WHERE email=$3",
        [subjectSessionId, randomUUID(), email],
      );
      expect(
        (
          await owner.query('SELECT FROM staff_sessions WHERE id=$1', [
            subjectSessionId,
          ])
        ).rowCount,
      ).toBe(1);
      await provision({
        subject: 'verified-google-subject-after-rotation',
        permissions: ['staff.directory.read'],
      });
      expect(
        (
          await owner.query('SELECT FROM staff_sessions WHERE id=$1', [
            subjectSessionId,
          ])
        ).rowCount,
      ).toBe(0);
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
      expect(
        (
          await owner.query(
            'SELECT FROM staff_sessions s JOIN staff_users u ON u.id=s.user_id WHERE u.email=$1',
            [email],
          )
        ).rowCount,
      ).toBe(0);
    });
  },
);
