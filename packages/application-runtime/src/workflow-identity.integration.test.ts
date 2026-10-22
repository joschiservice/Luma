import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { createWorkflowIdentity } from '@luma/identity/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('the workers’ identity login', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const database = `luma_workflow_identity_test_${suffix}`;
  const login = `luma_workflow_identity_test_${suffix}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const roleId = randomUUID();
  const buyer = randomUUID();
  const suspended = randomUUID();
  const outsider = randomUUID();
  let owner: Pool;
  let worker: Pool;
  let identity: ReturnType<typeof createWorkflowIdentity>;

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
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(`GRANT luma_workflow_identity TO "${login}"`);
    url.username = login;
    url.password = password;
    identity = createWorkflowIdentity({ databaseUrl: url.toString() });
    worker = new Pool({ connectionString: url.toString() });

    for (const [id, slug] of [
      [tenantId, 'workflow-identity'],
      [otherTenantId, 'workflow-identity-other'],
    ])
      await owner.query(
        "INSERT INTO organizations(id,name,slug,status,data_region,created_at) VALUES($1,'Workflow identity',$2,'active','AU',now())",
        [id, slug],
      );
    for (const [id, name] of [
      [buyer, 'Buyer'],
      [suspended, 'Suspended'],
      [outsider, 'Outsider'],
    ])
      await owner.query(
        'INSERT INTO users(id,name,email,email_verified,created_at,updated_at) VALUES($1,$2,$3,true,now(),now())',
        [id, name, `${id}@example.test`],
      );
    await owner.query(
      "INSERT INTO workspace_roles(tenant_id,id,name,created_by) VALUES($1,$2,'Buyer',$3)",
      [tenantId, roleId, buyer],
    );
    await owner.query(
      "INSERT INTO workspace_role_permissions(tenant_id,role_id,permission) VALUES($1,$2,'decisions.assign')",
      [tenantId, roleId],
    );
    await owner.query(
      "INSERT INTO memberships(id,tenant_id,user_id,role,custom_role_id,created_at) VALUES($1,$2,$3,'custom',$4,now())",
      [randomUUID(), tenantId, buyer, roleId],
    );
    await owner.query(
      "INSERT INTO memberships(id,tenant_id,user_id,role,status,suspended_at,suspended_by_kind,suspended_by,suspension_reason,created_at) VALUES($1,$2,$3,'member','suspended',now(),'staff',$4,'Integration test suspension',now())",
      [randomUUID(), tenantId, suspended, randomUUID()],
    );
    await owner.query(
      "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'admin',now())",
      [randomUUID(), otherTenantId, outsider],
    );
  }, 60_000);

  afterAll(async () => {
    await identity?.close();
    await worker?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.query(`DROP ROLE IF EXISTS "${login}"`);
    await admin.end();
  });

  it('resolves a workflow principal with their custom role', async () => {
    const context = await identity.service.resolveWorkflowContext(
      buyer,
      tenantId,
      'workflow-identity-test',
    );

    expect(context.tenantId).toBe(tenantId);
    expect(context.permissions.has('decisions.assign')).toBe(true);
    await expect(
      identity.service.resolveWorkflowContext(
        buyer,
        otherTenantId,
        'workflow-identity-test',
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lists only the selected workspace’s members, without names or emails', async () => {
    const context = await identity.service.resolveWorkflowContext(
      buyer,
      tenantId,
      'workflow-identity-test',
    );
    const members = await identity.service.listMembers(context);

    expect(members.map((member) => member.userId).sort()).toEqual(
      [buyer, suspended].sort(),
    );
    for (const member of members) {
      expect(member).not.toHaveProperty('name');
      expect(member).not.toHaveProperty('email');
    }
    expect([
      ...(await identity.service.suspendedMembers(context, [
        buyer,
        suspended,
        outsider,
      ])),
    ]).toEqual([suspended]);
  });

  it('cannot read or change accounts, sessions or memberships', async () => {
    for (const statement of [
      'SELECT email FROM users',
      'SELECT id FROM sessions',
      'SELECT id FROM accounts',
      'SELECT id FROM verifications',
      `UPDATE memberships SET role='owner' WHERE user_id='${buyer}'`,
    ])
      await expect(worker.query(statement), statement).rejects.toMatchObject({
        code: '42501',
      });
    await expect(identity.service.authenticate({})).rejects.toThrow(
      'Background workers can only read workspace members',
    );
  });
});
