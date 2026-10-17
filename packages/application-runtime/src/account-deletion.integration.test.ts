import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { AccountDisabledError, AccountErasedError } from '@luma/identity';
import { createIdentity } from '@luma/identity/composition';
import {
  createStaff,
  readStaffSettings,
  seedLocalStaff,
} from '@luma/staff/composition';
import { registerStaffHttp } from '@luma/staff/http';
import Fastify from 'fastify';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'account deletion with restricted PostgreSQL credentials',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const database = `luma_deletion_test_${suffix}`;
    const login = `luma_deletion_staff_${suffix}`;
    const customerLogin = `luma_deletion_customer_${suffix}`;
    const password = randomUUID();
    const admin = new Pool({ connectionString: databaseUrl });
    const origin = 'http://localhost:3212';
    const customerOrigin = 'http://localhost:3213';
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const owner = randomUUID();
    const sent: { id: string; to: string; subject: string }[] = [];
    let db: Pool;
    let customerDb: Pool;
    let staff: ReturnType<typeof createStaff>;
    let identity: ReturnType<typeof createIdentity>;
    let app: ReturnType<typeof Fastify>;
    let cookie: string;
    let customerUrl: string;

    const signUp = async (name: string, email: string) => {
      const response = await identity.handler(
        new Request(`${customerOrigin}/auth/sign-up/email`, {
          method: 'POST',
          headers: {
            origin: customerOrigin,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name,
            email,
            dataRegion: 'AU',
            password: 'customer-test-password-long-enough',
          }),
        }),
      );
      expect(response.status).toBe(200);
      // The emailed confirmation link would set this before the first sign-in, which opens the
      // account's session.
      await db.query('UPDATE users SET email_verified=true WHERE email=$1', [
        email,
      ]);
      expect((await signIn(email)).status).toBe(200);

      return ((await response.json()) as { user: { id: string } }).user.id;
    };
    const signIn = (email: string) =>
      identity.handler(
        new Request(`${customerOrigin}/auth/sign-in/email`, {
          method: 'POST',
          headers: {
            origin: customerOrigin,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email,
            password: 'customer-test-password-long-enough',
          }),
        }),
      );
    const join = (tenantId: string, userId: string, role: string) =>
      db.query(
        'INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,$4,now())',
        [randomUUID(), tenantId, userId, role],
      );
    // Staff ask; the account holder approves (here through the lifecycle trigger directly).
    const grant = async (userId: string) => {
      const requested = await app.inject({
        method: 'POST',
        url: `/v1/staff/accounts/${userId}/access-requests`,
        headers: { cookie, origin },
        payload: { reason: 'Deletion request from the account holder' },
      });
      expect(requested.statusCode, requested.body).toBe(201);
      const requestId = requested.json().id as string;
      await db.query(
        "UPDATE account_inspection_requests SET status='approved',decided_by=user_id WHERE id=$1",
        [requestId],
      );
      const response = await app.inject({
        method: 'POST',
        url: `/v1/staff/accounts/${userId}/access`,
        headers: { cookie, origin },
        payload: { requestId },
      });
      expect(response.statusCode, response.body).toBe(201);

      return response.json().id as string;
    };
    const command = (
      userId: string,
      path: 'deletion' | 'restore' | 'erasure',
      payload: Record<string, unknown>,
    ) =>
      app.inject({
        method: 'POST',
        url: `/v1/staff/accounts/${userId}/${path}`,
        headers: { cookie, origin },
        payload,
      });
    const memberships = async (userId: string) =>
      (
        await db.query<{
          tenant_id: string;
          role: string;
          status: string;
          suspended_by_kind: string | null;
        }>(
          'SELECT tenant_id,role,status,suspended_by_kind FROM memberships WHERE user_id=$1 ORDER BY tenant_id',
          [userId],
        )
      ).rows;

    beforeAll(async () => {
      await admin.query(`CREATE DATABASE "${database}"`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${database}`;
      db = new Pool({ connectionString: url.toString() });
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
      await db.query('SELECT luma_provision_cell_region($1)', ['AU']);
      for (const [name, role] of [
        [login, 'luma_staff_runtime'],
        [customerLogin, 'luma_identity'],
      ] as const) {
        await admin.query(
          `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
        );
        await admin.query(`GRANT ${role} TO "${name}"`);
      }
      const adminUrl = url.toString();
      const staffUrl = new URL(adminUrl);
      staffUrl.username = login;
      staffUrl.password = password;
      const settings = readStaffSettings({
        NODE_ENV: 'test',
        STAFF_DATABASE_URL: staffUrl.toString(),
        STAFF_PUBLIC_ORIGIN: origin,
        STAFF_AUTH_SECRET: 'integration-staff-secret-at-least-32-characters',
        STAFF_AUTH_MODE: 'local',
        STAFF_API_PORT: '3214',
        STAFF_COOKIE_PREFIX: 'deletion-staff',
      });
      await seedLocalStaff(
        settings,
        {
          name: 'Deletion operator',
          email: 'deletion@example.test',
          password: 'staff-test-password-long-enough',
          permissions: [
            'staff.directory.read',
            'staff.workspace.inspect',
            'staff.accounts.inspect',
            'staff.accounts.manage',
            'staff.accounts.delete',
          ],
        },
        adminUrl,
      );
      staff = createStaff(settings);
      app = Fastify();
      registerStaffHttp(app, staff);
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/auth/sign-in/email',
        headers: { origin },
        payload: {
          email: 'deletion@example.test',
          password: 'staff-test-password-long-enough',
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const cookies = response.headers['set-cookie'];
      cookie = (Array.isArray(cookies) ? cookies : [cookies])
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.split(';')[0])
        .join('; ');

      const customer = new URL(adminUrl);
      customer.username = customerLogin;
      customer.password = password;
      customerUrl = customer.toString();
      customerDb = new Pool({ connectionString: customerUrl });
      identity = createIdentity({
        databaseUrl: customerUrl,
        secret: 'separate-customer-secret-at-least-32-characters',
        baseURL: customerOrigin,
        trustedOrigins: [customerOrigin],
        cookiePrefix: 'deletion-customer',
        mailProvider: {
          async send(message) {
            sent.push(message);
          },
        },
      });
      await db.query(
        "INSERT INTO users(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Workspace Owner','owner@example.test',true,now(),now())",
        [owner],
      );
      await db.query(
        "INSERT INTO organizations(id,name,slug,status,data_region,created_at) VALUES($1,'Workspace Alpha','alpha','active','AU',now()),($2,'Workspace Beta','beta','active','AU',now())",
        [tenantA, tenantB],
      );
      await join(tenantA, owner, 'owner');
      await join(tenantB, owner, 'owner');
    }, 60000);

    afterAll(async () => {
      await app?.close();
      await staff?.close();
      await identity?.close();
      await customerDb?.end();
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.query(`DROP ROLE IF EXISTS "${login}"`);
      await admin.query(`DROP ROLE IF EXISTS "${customerLogin}"`);
      await admin.end();
    });

    it('schedules a deletion that refuses sign-in, and restores the exact previous state', async () => {
      const dana = await signUp('Dana Restore', 'dana@example.test');
      await join(tenantA, dana, 'admin');
      await join(tenantB, dana, 'member');
      // A suspension made before scheduling must survive the restore.
      await db.query(
        "UPDATE memberships SET status='suspended',suspended_at=now(),suspended_by_kind='staff',suspended_by=$2,suspension_reason='Suspended before the deletion request' WHERE tenant_id=$1 AND user_id=$3",
        [tenantB, randomUUID(), dana],
      );
      const before = await memberships(dana);
      const grantId = await grant(dana);
      const scheduling = {
        grantId,
        category: 'customer_request',
        reference: 'SUP-4411',
        reason: 'Account holder asked us to delete the account',
        commandId: randomUUID(),
        acknowledgeGlobalEffect: true,
      };
      expect(
        (
          await command(dana, 'deletion', {
            ...scheduling,
            acknowledgeGlobalEffect: undefined,
          })
        ).statusCode,
      ).toBe(400);
      const scheduled = await command(dana, 'deletion', scheduling);
      expect(scheduled.statusCode, scheduled.body).toBe(200);
      expect(scheduled.json()).toMatchObject({
        commandId: scheduling.commandId,
        status: 'scheduled',
        revokedSessions: 1,
      });
      const eraseAfter = Date.parse(scheduled.json().eraseAfter);
      expect(eraseAfter - Date.now()).toBeGreaterThan(29.9 * 86_400_000);
      expect(eraseAfter - Date.now()).toBeLessThan(30.1 * 86_400_000);
      // Exact retries return the original receipt; other uses of the ID conflict.
      expect((await command(dana, 'deletion', scheduling)).json()).toEqual(
        scheduled.json(),
      );
      expect(
        (await command(dana, 'deletion', { ...scheduling, reference: 'SUP-1' }))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await command(dana, 'deletion', {
            ...scheduling,
            commandId: randomUUID(),
          })
        ).json().message,
      ).toMatch(/already scheduled/);

      // During the window: no sessions, sign-in refused, every workspace and workflow rejects.
      const refused = await signIn('dana@example.test');
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'ACCOUNT_DISABLED' });
      expect(
        (await db.query('SELECT 1 FROM sessions WHERE user_id=$1', [dana]))
          .rowCount,
      ).toBe(0);
      await expect(
        identity.service.resolveWorkflowContext(dana, tenantA, 'workflow'),
      ).rejects.toBeInstanceOf(AccountDisabledError);
      expect(await memberships(dana)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tenant_id: tenantA,
            role: 'admin',
            status: 'suspended',
            suspended_by_kind: 'account_deletion',
          }),
          expect.objectContaining({
            tenant_id: tenantB,
            status: 'suspended',
            suspended_by_kind: 'staff',
          }),
        ]),
      );
      // Disabling commands can't undo the deletion's disablement.
      const enable = await app.inject({
        method: 'POST',
        url: `/v1/staff/accounts/${dana}/enable`,
        headers: { cookie, origin },
        payload: {
          grantId,
          reason: 'Trying to enable during deletion',
          commandId: randomUUID(),
        },
      });
      expect(enable.statusCode).toBe(409);
      expect(enable.json().message).toMatch(/scheduled for deletion/);
      const detail = await app.inject({
        url: `/v1/staff/accounts/${dana}?grantId=${grantId}`,
        headers: { cookie },
      });
      expect(detail.json()).toMatchObject({
        disabled: null,
        deletion: {
          category: 'customer_request',
          reference: 'SUP-4411',
          byName: 'Deletion operator',
          eraseRequestedAt: null,
        },
      });
      // The customer runtime can't erase before the window ends or start a deletion itself.
      const deletionId: string = scheduled.json().deletionId;
      await expect(
        customerDb.query('SELECT account_erase($1)', [deletionId]),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        customerDb.query(
          "SELECT identity_support_schedule_account_deletion($1,$2,'abuse','REF-1','A reason long enough','request')",
          [randomUUID(), owner],
        ),
      ).rejects.toMatchObject({ code: '42501' });

      const restoring = {
        grantId,
        reason: 'Account holder changed their mind',
        commandId: randomUUID(),
      };
      const restored = await command(dana, 'restore', restoring);
      expect(restored.statusCode, restored.body).toBe(200);
      expect(restored.json()).toMatchObject({
        status: 'restored',
        deletionId,
      });
      expect((await command(dana, 'restore', restoring)).json()).toEqual(
        restored.json(),
      );
      expect(
        (
          await command(dana, 'restore', {
            ...restoring,
            commandId: randomUUID(),
          })
        ).json().message,
      ).toMatch(/isn’t scheduled/);
      expect(await memberships(dana)).toEqual(before);
      expect(
        (
          await db.query(
            'SELECT 1 FROM account_disablements WHERE user_id=$1',
            [dana],
          )
        ).rowCount,
      ).toBe(0);
      expect((await signIn('dana@example.test')).status).toBe(200);
      expect(
        (await identity.service.resolveWorkflowContext(dana, tenantA, 'back'))
          .actor.role.key,
      ).toBe('admin');

      const events = await db.query(
        "SELECT event_type,staff_command_id FROM account_security_events WHERE user_id=$1 AND event_type LIKE 'account.%' ORDER BY created_at",
        [dana],
      );
      expect(events.rows).toEqual([
        {
          event_type: 'account.deletion-scheduled',
          staff_command_id: scheduling.commandId,
        },
        {
          event_type: 'account.restored',
          staff_command_id: restoring.commandId,
        },
      ]);
      const audit = await db.query(
        "SELECT event,details->>'reference' AS reference FROM staff_audit WHERE details->>'userId'=$1 AND event LIKE 'customer.account.%' ORDER BY sequence",
        [dana],
      );
      expect(audit.rows).toEqual([
        { event: 'customer.account.deletion_scheduled', reference: 'SUP-4411' },
        { event: 'customer.account.restored', reference: null },
      ]);
      await identity.mailDelivery.drain();
      expect(
        sent.filter((message) => message.to === 'dana@example.test'),
      ).toEqual([
        expect.objectContaining({
          subject: 'Your Luma account is scheduled for deletion',
        }),
        expect.objectContaining({ subject: 'Your Luma account was restored' }),
      ]);
    });

    it('keeps an already disabled account disabled after a restore', async () => {
      const finn = await signUp('Finn Disabled', 'finn@example.test');
      const grantId = await grant(finn);
      await db.query(
        "INSERT INTO account_disablements(user_id,disabled_by,reason_category,reason) VALUES($1,$2,'abuse','Disabled before the deletion')",
        [finn, randomUUID()],
      );
      expect(
        (
          await command(finn, 'deletion', {
            grantId,
            category: 'abuse',
            reference: 'ABUSE-12',
            reason: 'Repeated abuse after warnings',
            commandId: randomUUID(),
            acknowledgeGlobalEffect: true,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await command(finn, 'restore', {
            grantId,
            reason: 'Deletion scheduled by mistake',
            commandId: randomUUID(),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await db.query(
            'SELECT reason_category FROM account_disablements WHERE user_id=$1',
            [finn],
          )
        ).rows,
      ).toEqual([{ reason_category: 'abuse' }]);
    });

    it('refuses to delete the only owner of a workspace that isn’t closed', async () => {
      const olga = await signUp('Olga Owner', 'olga@example.test');
      const tenant = randomUUID();
      await db.query(
        "INSERT INTO organizations(id,name,slug,status,data_region,created_at) VALUES($1,'Workspace Solo',$2,'active','AU',now())",
        [tenant, `solo-${tenant}`],
      );
      await join(tenant, olga, 'owner');
      const grantId = await grant(olga);
      const schedule = () =>
        command(olga, 'deletion', {
          grantId,
          category: 'inactivity',
          reference: 'INACT-2026',
          reason: 'No sign-in for more than two years',
          commandId: randomUUID(),
          acknowledgeGlobalEffect: true,
        });
      const refused = await schedule();
      expect(refused.statusCode).toBe(409);
      expect(refused.json().message).toMatch(/only owner/);
      // An owner whose account is disabled doesn't count.
      const disabledOwner = await signUp(
        'Disabled Owner',
        'disabled-owner@example.test',
      );
      await join(tenant, disabledOwner, 'owner');
      await db.query(
        "INSERT INTO account_disablements(user_id,disabled_by,reason_category,reason) VALUES($1,$2,'abuse','Disabled co-owner for the test')",
        [disabledOwner, randomUUID()],
      );
      expect((await schedule()).statusCode).toBe(409);
      await db.query("UPDATE organizations SET status='closed' WHERE id=$1", [
        tenant,
      ]);
      expect((await schedule()).statusCode).toBe(200);
    });

    it('erases an account now, everywhere, and leaves only opaque references', async () => {
      const name = 'Erin Erasure-Person';
      const email = 'erin.erasure@example.test';
      const ip = '198.51.100.77';
      const agent = 'ErasureTestAgent/1.0 (unique)';
      const erin = await signUp(name, email);
      await join(tenantA, erin, 'member');
      await join(tenantB, erin, 'admin');
      await db.query(
        'UPDATE sessions SET ip_address=$2,user_agent=$3 WHERE user_id=$1',
        [erin, ip, agent],
      );
      await db.query(
        "INSERT INTO account_security_events(id,user_id,event_type,outcome,ip_address,user_agent,request_id) VALUES($1,$2,'sign-in.password','succeeded',$3,$4,'request')",
        [randomUUID(), erin, ip, agent],
      );
      await db.query(
        "INSERT INTO two_factors(id,user_id,secret,backup_codes) VALUES($1,$2,'secret','codes')",
        [randomUUID(), erin],
      );
      await db.query(
        "INSERT INTO passkeys(id,user_id,name,credential_id,public_key,counter,device_type,backed_up) VALUES($1,$2,'Laptop',$3,'key',0,'singleDevice',false)",
        [randomUUID(), erin, randomUUID()],
      );
      await db.query(
        "INSERT INTO verifications(id,identifier,value,expires_at,created_at,updated_at) VALUES($1,$2,$3,now()+interval '1 hour',now(),now())",
        [randomUUID(), `reset-password:${randomUUID()}`, erin],
      );
      await db.query(
        'INSERT INTO notification_preferences(tenant_id,user_id,issues) VALUES($1,$2,true)',
        [tenantA, erin],
      );
      await db.query(
        "INSERT INTO workspace_layouts(tenant_id,user_id,document) VALUES($1,$2,'{}')",
        [tenantA, erin],
      );
      // The invitation she accepted names her email in the workspace's records.
      const invitation = randomUUID();
      await db.query(
        "INSERT INTO workspace_invitations(tenant_id,id,email,role,status,token_hash,inviter_id,accepted_by,expires_at) VALUES($1,$2,$3,'member','accepted','hash',$4,$5,now()+interval '7 days')",
        [tenantA, invitation, email, owner, erin],
      );
      await db.query(
        "INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id,after_value) VALUES($1,$2,$3,'invitation.created',$4,$5)",
        [
          randomUUID(),
          tenantA,
          owner,
          invitation,
          { email, roleName: 'Member' },
        ],
      );
      await db.query(
        'INSERT INTO workspace_commands(tenant_id,id,actor_id,request,result) VALUES($1,$2,$3,$4,$5)',
        [
          tenantA,
          randomUUID(),
          owner,
          { email: email.toUpperCase(), role: 'member' },
          { email, name },
        ],
      );
      // An Activity entry she recorded keeps her opaque ID.
      await db.query(
        "INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id,after_value) VALUES($1,$2::uuid,$3,'workspace.updated',$2::text,$4)",
        [randomUUID(), tenantB, erin, { name: 'Workspace Beta' }],
      );
      const grantId = await grant(erin);
      const erasing = {
        grantId,
        reference: 'GDPR-17-0042',
        reason: 'Verified Art. 17 erasure request from the account holder',
        commandId: randomUUID(),
        acknowledgePermanent: true,
      };
      const requested = await command(erin, 'erasure', erasing);
      expect(requested.statusCode, requested.body).toBe(200);
      expect(requested.json()).toMatchObject({
        status: 'erasing',
        revokedSessions: 1,
      });
      expect(Date.parse(requested.json().eraseAfter)).toBeLessThanOrEqual(
        Date.now(),
      );
      expect(
        (
          await command(erin, 'restore', {
            grantId,
            reason: 'Trying to restore after erasure was requested',
            commandId: randomUUID(),
          })
        ).json().message,
      ).toMatch(/can’t be restored/);

      // The first pass queues the completion notice; erasure waits until it is sent.
      expect(await identity.eraseDueAccounts()).toEqual({ erased: 0 });
      await identity.mailDelivery.drain();
      expect(sent.filter((message) => message.to === email)).toEqual([
        expect.objectContaining({
          subject: 'Your Luma account has been deleted',
        }),
      ]);

      // An erasure interrupted midway rolls back, and the next pass completes it.
      const interrupted = new Client({ connectionString: customerUrl });
      interrupted.on('error', () => undefined);
      await interrupted.connect();
      try {
        await interrupted.query('BEGIN');
        await interrupted.query('SELECT account_erase($1)', [
          requested.json().deletionId,
        ]);
        const pid = (
          await interrupted.query<{ pid: number }>(
            'SELECT pg_backend_pid() AS pid',
          )
        ).rows[0]!.pid;
        await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      } finally {
        await interrupted.end().catch(() => undefined);
      }
      expect(
        (await db.query('SELECT 1 FROM users WHERE id=$1', [erin])).rowCount,
      ).toBe(1);
      expect(await identity.eraseDueAccounts()).toEqual({ erased: 1 });
      expect(await identity.eraseDueAccounts()).toEqual({ erased: 0 });
      expect(
        (
          await customerDb.query<{ erased: boolean }>(
            'SELECT account_erase($1) AS erased',
            [requested.json().deletionId],
          )
        ).rows[0]!.erased,
      ).toBe(false);

      // No table holds her name, email, IP address or user agent.
      const tables = (
        await db.query<{ name: string }>(
          "SELECT quote_ident(table_name) AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
        )
      ).rows.map((row) => row.name);
      expect(tables.length).toBeGreaterThan(50);
      const found: string[] = [];
      for (const table of tables)
        for (const needle of [name, email, ip, agent]) {
          const result = await db.query(
            `SELECT 1 FROM ${table} t WHERE strpos(lower(t::text),lower($1))>0 LIMIT 1`,
            [needle],
          );
          if (result.rowCount) found.push(`${table}: ${needle}`);
        }
      expect(found).toEqual([]);

      // History keeps her opaque ID: Activity names a former member, and work pauses.
      expect(
        (
          await db.query(
            'SELECT tenant_id,name,email,is_member FROM workspace_people WHERE user_id=$1 ORDER BY tenant_id',
            [erin],
          )
        ).rows,
      ).toEqual(
        [tenantA, tenantB].sort().map((tenant) => ({
          tenant_id: tenant,
          name: null,
          email: null,
          is_member: false,
        })),
      );
      expect(
        (
          await db.query(
            "SELECT event_type,actor_kind FROM workspace_access_events WHERE before_value->>'userId'=$1 AND event_type='member.remove'",
            [erin],
          )
        ).rows,
      ).toHaveLength(2);
      expect(
        (
          await db.query(
            'SELECT email,status,accepted_by FROM workspace_invitations WHERE id=$1',
            [invitation],
          )
        ).rows,
      ).toEqual([
        { email: `erased-${erin}`, status: 'accepted', accepted_by: erin },
      ]);
      await expect(
        identity.service.resolveWorkflowContext(erin, tenantA, 'workflow'),
      ).rejects.toBeInstanceOf(AccountErasedError);
      const ownerContext = await identity.service.resolveWorkflowContext(
        owner,
        tenantA,
        'owner-read',
      );
      expect(
        await identity.service.suspendedMembers(ownerContext, [erin, owner]),
      ).toEqual(new Set([erin]));

      // The receipt keeps only opaque IDs, timestamps, category, reference and staff actors.
      expect(
        (
          await db.query(
            'SELECT status,reason_category,reference,erased_at IS NOT NULL AS erased FROM account_deletions WHERE user_id=$1',
            [erin],
          )
        ).rows,
      ).toEqual([
        {
          status: 'erased',
          reason_category: 'gdpr_erasure',
          reference: 'GDPR-17-0042',
          erased: true,
        },
      ]);
      expect(
        (
          await db.query(
            "SELECT staff_user_id,details->>'deletionId' AS deletion FROM staff_audit WHERE event='customer.account.erased' AND details->>'userId'=$1",
            [erin],
          )
        ).rows,
      ).toEqual([
        { staff_user_id: null, deletion: requested.json().deletionId },
      ]);
      expect((await signIn(email)).status).toBe(401);
    });
  },
);
