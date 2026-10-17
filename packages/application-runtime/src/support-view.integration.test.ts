import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { apiContract } from '@luma/api-contract';
import { createIdentity } from '@luma/identity/composition';
import {
  identityRoutes,
  registerContractRoutes,
  registerIdentityGuards,
  requestIsReadOnly,
  restrictRequestToReads,
  runInRequestScope,
  settingsRoutes,
} from '@luma/identity/http';
import { ServiceError } from '@luma/platform';
import { createTenantDatabase } from '@luma/platform/composition';
import {
  createStaff,
  readStaffSettings,
  seedLocalStaff,
} from '@luma/staff/composition';
import { registerStaffHttp } from '@luma/staff/http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('read-only support views', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const database = `luma_support_view_test_${suffix}`;
  const staffLogin = `luma_support_staff_${suffix}`;
  const customerLogin = `luma_support_customer_${suffix}`;
  const password = randomUUID();
  const admin = new Pool({ connectionString: databaseUrl });
  const staffOrigin = 'http://localhost:3310';
  const customerOrigin = 'http://localhost:3309';
  const tenant = randomUUID();
  const owner = randomUUID();
  const member = randomUUID();
  let owners: Pool;
  let customerPool: Pool;
  let staffPool: Pool;
  let staff: ReturnType<typeof createStaff>;
  let identity: ReturnType<typeof createIdentity>;
  let staffApp: ReturnType<typeof Fastify>;
  let customerApp: ReturnType<typeof Fastify>;
  let staffCookie: string;
  let grantId: string;
  let inspectionRequestId: string;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${database}`;
    owners = new Pool({ connectionString: url.toString() });
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
    await owners.query('SELECT luma_provision_cell_region($1)', ['AU']);
    for (const [login, role] of [
      [staffLogin, 'luma_staff_runtime'],
      [customerLogin, 'luma_identity'],
    ] as const) {
      await admin.query(
        `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(`GRANT ${role} TO "${login}"`);
    }
    const adminUrl = url.toString();
    const as = (login: string) => {
      const target = new URL(adminUrl);
      target.username = login;
      target.password = password;

      return target.toString();
    };
    staffPool = new Pool({ connectionString: as(staffLogin) });
    customerPool = new Pool({ connectionString: as(customerLogin) });
    const settings = readStaffSettings({
      NODE_ENV: 'test',
      STAFF_DATABASE_URL: as(staffLogin),
      STAFF_PUBLIC_ORIGIN: staffOrigin,
      STAFF_CUSTOMER_ORIGIN: customerOrigin,
      STAFF_AUTH_SECRET: 'support-view-staff-secret-at-least-32-chars',
      STAFF_AUTH_MODE: 'local',
      STAFF_API_PORT: '3311',
      STAFF_COOKIE_PREFIX: 'support-view-staff',
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
          'staff.view-as',
          'staff.view-as.emergency',
          'staff.inspect.emergency',
        ],
      },
      adminUrl,
    );
    await owners.query(
      "INSERT INTO organizations(id,name,slug,status,data_region,created_at) VALUES($1,'Workspace Alpha','alpha','active','AU',now())",
      [tenant],
    );
    await owners.query(
      "INSERT INTO users(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Olivia Owner','owner@example.test',true,now(),now()),($2,'Max Member','member@example.test',true,now(),now())",
      [owner, member],
    );
    await owners.query(
      "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$3,$4,'owner',now()),($2,$3,$5,'member',now())",
      [randomUUID(), randomUUID(), tenant, owner, member],
    );
    staff = createStaff(settings);
    staffApp = Fastify();
    registerStaffHttp(staffApp, staff);
    await staffApp.ready();
    const signIn = await staffApp.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin: staffOrigin },
      payload: {
        email: 'support@example.test',
        password: 'staff-test-password-long-enough',
      },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const cookies = signIn.headers['set-cookie'];
    staffCookie = (Array.isArray(cookies) ? cookies : [cookies])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.split(';')[0])
      .join('; ');
    identity = createIdentity({
      databaseUrl: as(customerLogin),
      secret: 'support-view-customer-secret-at-least-32-chars',
      baseURL: customerOrigin,
      trustedOrigins: [customerOrigin],
      cookiePrefix: 'support-view-customer',
      readOnly: requestIsReadOnly,
    });
    customerApp = Fastify();
    registerIdentityGuards(customerApp, identity.service, [customerOrigin]);
    customerApp.setErrorHandler(
      (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
        if (error instanceof ServiceError)
          return reply
            .status(error.statusCode)
            .send({ code: error.code, message: error.message });
        request.log.error(error);

        return reply.status(500).send({ code: 'INTERNAL_ERROR' });
      },
    );
    registerContractRoutes(
      customerApp,
      apiContract.identity,
      identityRoutes(identity.service),
    );
    registerContractRoutes(
      customerApp,
      apiContract.settings,
      settingsRoutes(identity.settings),
    );
    await customerApp.ready();
    // Staff inspect the workspace only after an owner approves their request.
    const approved = await approvedGrant(
      'Customer reported a missing order on Home',
    );
    grantId = approved.id;
    inspectionRequestId = approved.requestId;
  }, 60_000);

  afterAll(async () => {
    await customerApp?.close();
    await staffApp?.close();
    await staff?.close();
    await identity?.close();
    await staffPool?.end();
    await customerPool?.end();
    await owners?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.query(`DROP ROLE IF EXISTS "${staffLogin}"`);
    await admin.query(`DROP ROLE IF EXISTS "${customerLogin}"`);
    await admin.end();
  });

  const ownerContext = () =>
    identity.service.resolveWorkflowContext(owner, tenant, randomUUID());

  const staffRequest = (
    method: 'GET' | 'POST',
    path: string,
    payload?: Record<string, unknown>,
  ) =>
    staffApp.inject({
      method,
      url: `/v1/staff/workspaces/${tenant}/${path}`,
      headers: { origin: staffOrigin, cookie: staffCookie },
      ...(payload ? { payload } : {}),
    });

  /** Requests inspection, approves it as the owner and opens a grant for the staff session. */
  async function approvedGrant(reason: string) {
    const requested = await staffRequest('POST', 'access-requests', { reason });
    expect(requested.statusCode, requested.body).toBe(201);
    await identity.settings.decideSupportInspection(
      await ownerContext(),
      requested.json().id,
      { commandId: randomUUID(), decision: 'approve' },
    );
    const opened = await staffRequest('POST', 'access', {
      requestId: requested.json().id,
    });
    expect(opened.statusCode, opened.body).toBe(201);

    return {
      id: opened.json().id as string,
      requestId: requested.json().id as string,
    };
  }

  const startView = (body: Record<string, unknown>, userId: string = member) =>
    staffApp.inject({
      method: 'POST',
      url: `/v1/staff/workspaces/${tenant}/users/${userId}/support-view`,
      headers: { origin: staffOrigin, cookie: staffCookie },
      payload: { grantId, ...body },
    });

  async function openView(body: Record<string, unknown>) {
    const started = await startView(body);
    expect(started.statusCode, started.body).toBe(201);
    const url = new URL(started.json().url);
    expect(url.origin).toBe(customerOrigin);
    expect(url.pathname).toBe('/support-view');
    const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
    const redeemed = await customerApp.inject({
      method: 'POST',
      url: '/v1/support-view/redeem',
      headers: { origin: customerOrigin },
      payload: { token },
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    expect(redeemed.json()).toEqual({ workspaceId: tenant });
    const cookie = String(redeemed.headers['set-cookie']);
    expect(cookie).toMatch(
      /^support-view-customer\.support_view=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=1800$/,
    );

    return {
      id: started.json().id as string,
      token,
      cookie: cookie.split(';')[0]!,
    };
  }

  const events = async (type: string) =>
    (
      await owners.query<{
        actor_kind: string;
        after_value: Record<string, unknown>;
      }>(
        'SELECT actor_kind,after_value FROM workspace_access_events WHERE tenant_id=$1 AND event_type=$2 ORDER BY created_at',
        [tenant, type],
      )
    ).rows;

  it('needs consent, which owners give directly or by approving a request', async () => {
    const refused = await startView({
      mode: 'consent',
      reason: 'Reproduce the Home layout problem',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/doesn’t allow Luma support access/);
    const requested = await staffApp.inject({
      method: 'POST',
      url: `/v1/staff/workspaces/${tenant}/support-access-requests`,
      headers: { origin: staffOrigin, cookie: staffCookie },
      payload: {
        grantId,
        reason: 'We need to see the Home layout the customer reported',
        durationHours: 72,
      },
    });
    expect(requested.statusCode, requested.body).toBe(201);
    const again = await staffApp.inject({
      method: 'POST',
      url: `/v1/staff/workspaces/${tenant}/support-access-requests`,
      headers: { origin: staffOrigin, cookie: staffCookie },
      payload: {
        grantId,
        reason: 'A second request too soon',
        durationHours: 24,
      },
    });
    expect(again.statusCode).toBe(409);
    const detail = await staffApp.inject({
      url: `/v1/staff/workspaces/${tenant}?grantId=${grantId}`,
      headers: { cookie: staffCookie },
    });
    expect(detail.json().supportAccess).toEqual({
      allowedUntil: null,
      request: expect.objectContaining({
        id: requested.json().id,
        durationHours: 72,
      }),
    });
    expect(
      (
        await owners.query(
          "SELECT user_id FROM workspace_mail WHERE tenant_id=$1 AND kind='support_access_requested'",
          [tenant],
        )
      ).rows,
    ).toEqual([{ user_id: owner }]);

    const context = await ownerContext();
    const pending = await identity.settings.supportAccess(context);
    expect(pending.requests).toEqual([
      expect.objectContaining({
        id: requested.json().id,
        reason: 'We need to see the Home layout the customer reported',
      }),
    ]);
    const approved = await identity.settings.decideSupportAccessRequest(
      context,
      requested.json().id,
      { commandId: randomUUID(), decision: 'approve' },
    );
    expect(approved.requests).toEqual([]);
    expect(Date.parse(approved.allowedUntil!) - Date.now()).toBeGreaterThan(
      71 * 3600_000,
    );
    expect(await events('support_access.request_approved')).toHaveLength(1);
    expect((await events('support_access.requested'))[0]?.actor_kind).toBe(
      'staff',
    );
  });

  it('shows the member read-only, records each first read and refuses changes', async () => {
    const view = await openView({
      mode: 'consent',
      reason: 'Reproduce the Home layout problem',
    });
    const reuse = await customerApp.inject({
      method: 'POST',
      url: '/v1/support-view/redeem',
      headers: { origin: customerOrigin },
      payload: { token: view.token },
    });
    expect(reuse.statusCode).toBe(404);

    const base = `/v1/organizations/${tenant}`;
    const context = await customerApp.inject({
      url: `${base}/context`,
      headers: { cookie: view.cookie },
    });
    expect(context.statusCode, context.body).toBe(200);
    expect(context.json()).toMatchObject({
      actor: { id: member, role: { id: 'member' } },
      supportView: { id: view.id, mode: 'consent' },
    });
    expect(context.json().permissions).not.toContain('support_access.manage');
    // Settings reads run in read-only transactions without the locks writes take.
    for (const path of ['layout', '', 'layout'])
      expect(
        (
          await customerApp.inject({
            url: `${base}/settings${path ? `/${path}` : ''}`,
            headers: { cookie: view.cookie },
          })
        ).statusCode,
      ).toBe(200);
    const state = await customerApp.inject({
      url: '/v1/support-view',
      headers: { cookie: view.cookie },
    });
    expect(state.json()).toMatchObject({
      active: true,
      workspace: { id: tenant, name: 'Workspace Alpha' },
      member: { id: member, name: 'Max Member' },
    });
    const organizations = await customerApp.inject({
      url: '/v1/organizations',
      headers: { cookie: view.cookie },
    });
    expect(
      organizations.json().items.map((item: { id: string }) => item.id),
    ).toEqual([tenant]);

    for (const request of [
      {
        method: 'PATCH' as const,
        url: `${base}/settings/notifications`,
        payload: {
          commandId: randomUUID(),
          revision: 0,
          issues: true,
          connections: true,
        },
      },
      {
        method: 'PUT' as const,
        url: `${base}/settings/support-access`,
        payload: { commandId: randomUUID(), revision: 1, durationHours: 168 },
      },
    ]) {
      const response = await customerApp.inject({
        ...request,
        headers: { origin: customerOrigin, cookie: view.cookie },
      });
      expect(response.statusCode, request.url).toBe(403);
      expect(response.json().code).toBe('READ_ONLY');
    }
    const security = await customerApp.inject({
      url: '/v1/account/security-events',
      headers: { cookie: view.cookie },
    });
    expect(security.statusCode).toBe(403);

    const reads = await owners.query<{ path: string }>(
      "SELECT details->>'path' AS path FROM staff_audit WHERE event='view-as.read' AND details->>'viewId'=$1 ORDER BY sequence",
      [view.id],
    );
    expect(reads.rows.map((row) => row.path)).toEqual([
      `${base}/context`,
      `${base}/settings/layout`,
      `${base}/settings`,
    ]);
    expect(
      (await events('support_view.read')).map((event) => event.after_value),
    ).toEqual([
      { userId: member, path: '/context' },
      { userId: member, path: '/settings/layout' },
      { userId: member, path: '/settings' },
    ]);
    expect(await events('support_view.started')).toEqual([
      {
        actor_kind: 'staff',
        after_value: expect.objectContaining({
          userId: member,
          mode: 'consent',
        }),
      },
    ]);
    expect(
      (
        await owners.query(
          "SELECT user_id FROM workspace_mail WHERE tenant_id=$1 AND kind='support_view_started' AND target_id=$2",
          [tenant, view.id],
        )
      ).rows,
    ).toEqual([{ user_id: owner }]);
  });

  it('ends open views on their next request once consent is revoked', async () => {
    const view = await openView({
      mode: 'consent',
      reason: 'Check the filters the member sees',
    });
    const base = `/v1/organizations/${tenant}`;
    expect(
      (
        await customerApp.inject({
          url: `${base}/members`,
          headers: { cookie: view.cookie },
        })
      ).statusCode,
    ).toBe(200);
    const context = await ownerContext();
    const access = await identity.settings.supportAccess(context);
    await identity.settings.revokeSupportAccess(context, {
      commandId: randomUUID(),
      revision: access.revision,
    });
    const after = await customerApp.inject({
      url: `${base}/members`,
      headers: { cookie: view.cookie },
    });
    expect(after.statusCode).toBe(401);
    const ended = await owners.query(
      "SELECT details FROM staff_audit WHERE event='view-as.ended' AND details->>'viewId'=$1",
      [view.id],
    );
    expect(ended.rows[0]?.details).toMatchObject({
      endReason: 'consent_revoked',
      paths: 1,
    });
    const state = await customerApp.inject({
      url: '/v1/support-view',
      headers: { cookie: view.cookie },
    });
    expect(state.json()).toEqual({
      active: false,
      endReason: 'consent_revoked',
    });
    expect(String(state.headers['set-cookie'])).toContain('Max-Age=0');
    const refused = await startView({
      mode: 'consent',
      reason: 'Check the filters the member sees',
    });
    expect(refused.statusCode).toBe(409);
  });

  it('allows emergency views without consent, with a category and reference, and emails owners afterwards', async () => {
    const missing = await startView({
      mode: 'emergency',
      reason: 'Investigate a reported account takeover',
    });
    expect(missing.statusCode).toBe(400);
    const view = await openView({
      mode: 'emergency',
      reason: 'Investigate a reported account takeover',
      category: 'security_incident',
      reference: 'SEC-2026-114',
    });
    expect(await events('support_view.emergency_started')).toHaveLength(1);
    const ended = await customerApp.inject({
      method: 'POST',
      url: '/v1/support-view/end',
      headers: { origin: customerOrigin, cookie: view.cookie },
    });
    expect(ended.statusCode).toBe(204);
    expect(
      (
        await owners.query(
          'SELECT kind,user_id FROM workspace_mail WHERE tenant_id=$1 AND target_id=$2',
          [tenant, view.id],
        )
      ).rows,
    ).toEqual([{ kind: 'support_view_ended', user_id: owner }]);
    const audit = await owners.query(
      "SELECT reason,details FROM staff_audit WHERE event='view-as.started' AND details->>'viewId'=$1",
      [view.id],
    );
    expect(audit.rows[0]).toMatchObject({
      reason: 'Investigate a reported account takeover',
      details: { category: 'security_incident', reference: 'SEC-2026-114' },
    });
  });

  it('records the end of views nobody opened, and keeps view state out of runtime reach', async () => {
    const started = await startView({
      mode: 'emergency',
      reason: 'Check a legal hold on order records',
      category: 'legal_request',
      reference: 'LEGAL-77',
    });
    expect(started.statusCode).toBe(201);
    await owners.query(
      "UPDATE support_view_sessions SET handoff_expires_at=now()-interval '1 second' WHERE id=$1",
      [started.json().id],
    );
    expect(await identity.service.sweepSupportViews('sweep')).toBeGreaterThan(
      0,
    );
    const view = await owners.query(
      'SELECT end_reason FROM support_view_sessions WHERE id=$1',
      [started.json().id],
    );
    expect(view.rows[0]?.end_reason).toBe('expired');

    await expect(
      customerPool.query('SELECT token_hash FROM support_view_sessions'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      customerPool.query(
        'SELECT staff_user_id FROM workspace_support_access_requests',
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      staffPool.query('SELECT * FROM workspace_support_access'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      staffPool.query('SELECT * FROM support_view_sessions'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      customerPool.query(
        "SELECT support_view_start($1,$2,'emergency','A forged start request','legal_request','X-1',repeat('a',64),'forged')",
        [tenant, member],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('opens tenant transactions read-only in a request restricted to reads', async () => {
    const database = createTenantDatabase(owners, {
      readOnly: requestIsReadOnly,
    });
    await expect(
      runInRequestScope(async () => {
        restrictRequestToReads();

        return database.transaction(tenant, (tx) =>
          tx.query(
            "INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id) VALUES(gen_random_uuid(),$1,$2,'test','test')",
            [tenant, owner],
          ),
        );
      }),
    ).rejects.toMatchObject({ code: '25006' });
    await expect(
      runInRequestScope(() =>
        database.transaction(tenant, (tx) => tx.query('SELECT 1')),
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('lets owners answer and revoke inspection, lapses unanswered requests and records each state', async () => {
    const context = await ownerContext();
    const latest = async () =>
      (await staffRequest('GET', 'access-requests/latest')).json().request;
    const readWorkspace = (grant: string) =>
      staffApp.inject({
        url: `/v1/staff/workspaces/${tenant}?grantId=${grant}`,
        headers: { cookie: staffCookie },
      });
    const actors = async (type: string) =>
      (
        await owners.query<{ actor_id: string; actor_kind: string }>(
          'SELECT actor_id,actor_kind FROM workspace_access_events WHERE tenant_id=$1 AND event_type=$2 ORDER BY created_at',
          [tenant, type],
        )
      ).rows;

    // Owners see the reason they must judge, never who asked.
    const open = await identity.settings.supportAccess(context);
    expect(open.inspections).toEqual([
      {
        id: inspectionRequestId,
        status: 'approved',
        emergency: null,
        reason: 'Customer reported a missing order on Home',
        requestedAt: expect.any(String),
        expiresAt: expect.any(String),
        accessExpiresAt: expect.any(String),
      },
    ]);
    expect(
      Date.parse(open.inspections[0]!.accessExpiresAt!) - Date.now(),
    ).toBeLessThanOrEqual(30 * 60_000);

    // Revoking ends the grant on its next use.
    expect((await readWorkspace(grantId)).statusCode).toBe(200);
    const revoked = await identity.settings.revokeSupportInspection(
      context,
      inspectionRequestId,
      { commandId: randomUUID() },
    );
    expect(revoked.inspections).toEqual([]);
    expect((await readWorkspace(grantId)).statusCode).toBe(403);
    expect(await latest()).toMatchObject({
      id: inspectionRequestId,
      status: 'revoked',
    });
    expect(await actors('support_inspection.revoked')).toEqual([
      { actor_id: owner, actor_kind: 'member' },
    ]);
    await expect(
      identity.settings.revokeSupportInspection(context, inspectionRequestId, {
        commandId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // A declined request opens nothing.
    const declined = (
      await staffRequest('POST', 'access-requests', {
        reason: 'Check the order sync history again',
      })
    ).json().id as string;
    await identity.settings.decideSupportInspection(context, declined, {
      commandId: randomUUID(),
      decision: 'decline',
    });
    expect(await latest()).toMatchObject({ id: declined, status: 'declined' });
    expect(
      (await staffRequest('POST', 'access', { requestId: declined }))
        .statusCode,
    ).toBe(403);
    expect(await actors('support_inspection.declined')).toEqual([
      { actor_id: owner, actor_kind: 'member' },
    ]);

    // An unanswered request lapses after 24 hours; the sweep records it as Luma's.
    const lapsing = (
      await staffRequest('POST', 'access-requests', {
        reason: 'Look at the sync errors from last week',
      })
    ).json().id as string;
    const shift = await owners.connect();
    try {
      await shift.query('BEGIN');
      // Move the request into the past without the lifecycle trigger, as time would.
      await shift.query('SET LOCAL session_replication_role=replica');
      await shift.query(
        "UPDATE workspace_inspection_requests SET expires_at=now()-interval '1 second' WHERE id=$1",
        [lapsing],
      );
      await shift.query('COMMIT');
    } finally {
      shift.release();
    }
    expect(await latest()).toMatchObject({ id: lapsing, status: 'expired' });
    await expect(
      identity.settings.decideSupportInspection(context, lapsing, {
        commandId: randomUUID(),
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await identity.service.sweepSupportViews('inspection-sweep');
    expect(await actors('support_inspection.expired')).toEqual([
      {
        actor_id: '00000000-0000-0000-0000-000000000000',
        actor_kind: 'member',
      },
    ]);

    // Emergency access opens at once, is recorded and emailed, and owners can't revoke it.
    const emergency = await staffRequest('POST', 'access', {
      reason: 'Account takeover reported to the security team',
      emergency: { category: 'security_incident', reference: 'SEC-204' },
    });
    expect(emergency.statusCode, emergency.body).toBe(201);
    expect((await readWorkspace(emergency.json().id)).statusCode).toBe(200);
    const emergencyRecord = await owners.query(
      "SELECT actor_kind,after_value FROM workspace_access_events WHERE tenant_id=$1 AND event_type='support_inspection.emergency_opened'",
      [tenant],
    );
    expect(emergencyRecord.rows).toEqual([
      {
        actor_kind: 'staff',
        after_value: {
          status: 'approved',
          category: 'security_incident',
          expiresAt: expect.any(String),
        },
      },
    ]);
    expect(JSON.stringify(emergencyRecord.rows)).not.toMatch(
      /SEC-204|takeover/,
    );
    expect(
      (
        await owners.query(
          "SELECT user_id FROM workspace_mail WHERE tenant_id=$1 AND kind='support_inspection_emergency'",
          [tenant],
        )
      ).rows,
    ).toEqual([{ user_id: owner }]);
    expect(
      (
        await owners.query(
          "SELECT reason,details->>'reference' AS reference FROM staff_audit WHERE event='workspace.access.emergency' AND tenant_id=$1",
          [tenant],
        )
      ).rows,
    ).toEqual([
      {
        reason: 'Account takeover reported to the security team',
        reference: 'SEC-204',
      },
    ]);
    const listed = await identity.settings.supportAccess(context);
    expect(listed.inspections).toEqual([
      expect.objectContaining({
        status: 'approved',
        emergency: 'security_incident',
        reason: null,
      }),
    ]);
    await expect(
      identity.settings.revokeSupportInspection(
        context,
        listed.inspections[0]!.id,
        { commandId: randomUUID() },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Runtimes reach requests only through their narrow grants and row security.
    await expect(
      customerPool.query(
        'SELECT staff_user_id FROM workspace_inspection_requests',
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      customerPool.query(
        "UPDATE workspace_inspection_requests SET reason='Forged reason text'",
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      staffPool.query('SELECT id FROM workspace_inspection_requests'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      customerPool.query(
        "SELECT support_inspection_request($1,'consent','A forged request text',NULL,NULL,'forged')",
        [tenant],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const scoped = await customerPool.connect();
    try {
      await scoped.query('BEGIN');
      await scoped.query("SELECT set_config('app.tenant_id',$1,true)", [
        randomUUID(),
      ]);
      expect(
        (await scoped.query('SELECT id FROM workspace_inspection_requests'))
          .rowCount,
      ).toBe(0);
      await scoped.query('ROLLBACK');
    } finally {
      scoped.release();
    }
  });
});
