import { randomUUID } from 'node:crypto';

import { hashPassword } from 'better-auth/crypto';
import { Pool } from 'pg';

import type { StaffRuntime } from './application/staff.js';
import { createStaffService } from './application/staff.js';
import type { StaffContext, StaffPermission } from './domain/access.js';
import { StaffError, staffPermissions } from './domain/access.js';
import {
  createAuditedStaffAuthHandler,
  createStaffAuth,
} from './infrastructure/auth.js';
import { createStaffRepository } from './infrastructure/repository.js';
import type { StaffSettings } from './infrastructure/settings.js';
import {
  validateLocalStaffDatabaseUrl,
  validateStaffAdministratorDatabaseUrl,
  validateStaffProvisioning,
  validateStaffSettings,
} from './infrastructure/settings.js';

export { readStaffSettings } from './infrastructure/settings.js';

export type { StaffSettings } from './infrastructure/settings.js';

/** Owns isolated staff database resources, authentication and application services. */
export function createStaff(settings: StaffSettings) {
  settings = validateStaffSettings(settings);
  const pool = new Pool({
    connectionString: settings.databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
  });
  const auth = createStaffAuth(pool, settings);

  return {
    settings,
    service: createStaffService(createStaffRepository(pool), {
      customerOrigin: settings.customerOrigin,
    }),
    authHandler: createAuditedStaffAuthHandler(auth, pool),
    /** Resolves current staff authority and bounded session lifetime. Only explicit browser activity advances the idle timestamp. */
    async resolveSession(
      headers: Headers,
      requestId: string,
    ): Promise<{
      context: StaffContext;
      user: { id: string; name: string; email: string };
    }> {
      const session = await auth.api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
      });
      if (!session) throw new StaffError(401, 'Staff sign-in required.');
      const result = await pool.query<{
        permissions: string[];
        created_at: Date;
      }>(
        headers.get('x-luma-staff-activity') === 'true'
          ? `UPDATE staff_sessions s SET updated_at=clock_timestamp() FROM staff_users u,staff_access a WHERE s.id=$1 AND s.user_id=u.id AND a.email=lower(u.email) AND a.active AND (($2='local' AND a.provider_subject IS NULL AND s.provider_subject IS NULL) OR ($2='google' AND a.provider_subject IS NOT NULL AND s.provider_subject=a.provider_subject)) AND s.expires_at>clock_timestamp() AND s.created_at>clock_timestamp()-interval '8 hours' AND s.updated_at>clock_timestamp()-interval '30 minutes' RETURNING a.permissions,s.created_at`
          : `SELECT a.permissions,s.created_at FROM staff_sessions s JOIN staff_users u ON s.user_id=u.id JOIN staff_access a ON a.email=lower(u.email) WHERE s.id=$1 AND a.active AND (($2='local' AND a.provider_subject IS NULL AND s.provider_subject IS NULL) OR ($2='google' AND a.provider_subject IS NOT NULL AND s.provider_subject=a.provider_subject)) AND s.expires_at>clock_timestamp() AND s.created_at>clock_timestamp()-interval '8 hours' AND s.updated_at>clock_timestamp()-interval '30 minutes'`,
        [session.session.id, settings.mode],
      );
      const access = result.rows[0];
      if (!access)
        throw new StaffError(403, 'Staff access is unavailable or expired.');
      const permissions = access.permissions.filter(
        (permission): permission is StaffPermission =>
          staffPermissions.some((known) => known === permission),
      );

      return {
        context: {
          userId: session.user.id,
          sessionId: session.session.id,
          sessionCreatedAt: access.created_at,
          permissions,
          requestId,
        },
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
        },
      };
    },
    /** Checks that staff runtime credentials cannot inherit owner, customer or commerce privileges. */
    async checkReadiness() {
      const result = await pool.query<{ safe: boolean }>(
        `SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND pg_has_role(current_user,'luma_staff_runtime','MEMBER') AND NOT pg_has_role(current_user,'luma_identity','MEMBER') AND NOT pg_has_role(current_user,'luma_identity_support','MEMBER') AND NOT pg_has_role(current_user,'luma_staff_views','MEMBER') AND NOT pg_has_role(current_user,'luma_staff_directory','MEMBER') AND NOT EXISTS(SELECT FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') AND pg_has_role(current_user,c.relowner,'MEMBER')) AND NOT EXISTS(SELECT FROM pg_roles granted WHERE left(granted.rolname,5)='luma_' AND granted.rolname NOT IN(current_user,'luma_staff_runtime') AND pg_has_role(current_user,granted.oid,'MEMBER')) AND NOT EXISTS(SELECT FROM pg_class customer_table WHERE customer_table.relnamespace='public'::regnamespace AND customer_table.relkind IN('r','p') AND left(customer_table.relname,6)<>'staff_' AND (has_table_privilege(current_user,customer_table.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,customer_table.oid,'INSERT,UPDATE,REFERENCES'))) AND NOT has_column_privilege(current_user,'sessions','token','SELECT') AND NOT has_column_privilege(current_user,'accounts','password','SELECT') AND NOT has_column_privilege(current_user,'connector_installations','document','SELECT') AND NOT has_column_privilege(current_user,'connector_installations','secret','SELECT') AND NOT has_table_privilege(current_user,'sessions','DELETE') AND NOT has_table_privilege(current_user,'connector_installations','UPDATE') AS safe FROM pg_roles r WHERE r.rolname=current_user`,
      );
      await pool.query('SELECT id FROM staff_users LIMIT 0');

      return result.rows[0]?.safe === true;
    },
    /** Releases the staff-only database pool. */
    close: () => pool.end(),
  } satisfies StaffRuntime;
}

/** Seeds a local-only staff login through administrator credentials; runtime cannot grant staff privileges. */
export async function seedLocalStaff(
  settings: StaffSettings,
  input: {
    email: string;
    name: string;
    password: string;
    permissions: StaffPermission[];
  },
  administratorDatabaseUrl: string,
) {
  settings = validateStaffSettings(settings);
  administratorDatabaseUrl = validateStaffAdministratorDatabaseUrl(
    administratorDatabaseUrl,
  );
  if (settings.mode !== 'local' || settings.environment === 'production')
    throw new Error('Staff credential seeding is development-only.');
  administratorDatabaseUrl = validateLocalStaffDatabaseUrl(
    administratorDatabaseUrl,
  );
  if (
    input.password.length < 12 ||
    !input.permissions.every((permission) =>
      staffPermissions.includes(permission),
    )
  )
    throw new Error('Invalid staff seed credentials or permissions.');
  const pool = new Pool({ connectionString: administratorDatabaseUrl, max: 1 });
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const email = input.email.trim().toLowerCase();
    const user = await tx.query<{ id: string }>(
      'INSERT INTO staff_users(id,name,email,email_verified,created_at,updated_at) VALUES($1,$2,$3,true,now(),now()) ON CONFLICT(email) DO UPDATE SET name=excluded.name RETURNING id',
      [randomUUID(), input.name, email],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error('Staff seed user unavailable.');
    await tx.query(
      "INSERT INTO staff_accounts(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES($1,$2::text,'credential',$2::uuid,$3,now(),now()) ON CONFLICT(provider_id,account_id) DO NOTHING",
      [randomUUID(), userId, await hashPassword(input.password)],
    );
    const admitted = await tx.query(
      'INSERT INTO staff_access(email,permissions) VALUES($1,$2) ON CONFLICT(email) DO NOTHING',
      [email, input.permissions],
    );
    if (admitted.rowCount)
      await tx.query(
        "INSERT INTO staff_audit(staff_user_id,event,request_id,details) VALUES($1,'staff.local.provisioned','local-setup',$2)",
        [userId, JSON.stringify({ permissions: input.permissions })],
      );
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
    await pool.end();
  }
}

/** Provisions or revokes an explicitly identified Google staff principal using administrator credentials. */
export async function provisionStaffIdentity(
  administratorDatabaseUrl: string,
  input: {
    email: string;
    subject: string;
    active: boolean;
    permissions: StaffPermission[];
    operator: string;
    reason: string;
  },
) {
  input = validateStaffProvisioning(input);
  administratorDatabaseUrl = validateStaffAdministratorDatabaseUrl(
    administratorDatabaseUrl,
  );
  const pool = new Pool({ connectionString: administratorDatabaseUrl, max: 1 });
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('staff-admission:'||$1,0))",
      [input.email],
    );
    const previous = await tx.query<{
      provider_subject: string | null;
      active: boolean;
      permissions: string[];
    }>(
      'SELECT provider_subject,active,permissions FROM staff_access WHERE email=$1 FOR UPDATE',
      [input.email],
    );
    const admission = previous.rows[0];
    if (
      !input.active ||
      !admission ||
      (admission &&
        (admission.provider_subject !== input.subject ||
          admission.active !== input.active ||
          [...admission.permissions].sort().join(',') !==
            [...input.permissions].sort().join(',')))
    )
      await tx.query(
        'DELETE FROM staff_sessions s USING staff_users u WHERE s.user_id=u.id AND lower(u.email)=$1',
        [input.email],
      );
    const principal = await tx.query<{ id: string }>(
      'SELECT id FROM staff_users WHERE lower(email)=$1 FOR UPDATE',
      [input.email],
    );
    const principalId = principal.rows[0]?.id;
    if (principalId) {
      // This is an explicit administrator binding, never automatic linking by email during sign-in.
      const existing = await tx.query<{ account_id: string }>(
        "SELECT account_id FROM staff_accounts WHERE user_id=$1 AND provider_id='google'",
        [principalId],
      );
      if (
        existing.rows.length !== 1 ||
        existing.rows[0]?.account_id !== input.subject
      ) {
        await tx.query('DELETE FROM staff_sessions WHERE user_id=$1', [
          principalId,
        ]);
        await tx.query(
          "DELETE FROM staff_accounts WHERE user_id=$1 AND provider_id='google'",
          [principalId],
        );
        await tx.query(
          "INSERT INTO staff_accounts(id,account_id,provider_id,user_id,created_at,updated_at) VALUES($1,$2,'google',$3,now(),now())",
          [randomUUID(), input.subject, principalId],
        );
      }
    }
    await tx.query(
      'INSERT INTO staff_access(email,provider_subject,active,permissions) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET provider_subject=excluded.provider_subject,active=excluded.active,permissions=excluded.permissions',
      [
        input.email.toLowerCase(),
        input.subject,
        input.active,
        input.permissions,
      ],
    );
    await tx.query(
      "INSERT INTO staff_audit(event,request_id,reason,details) VALUES('staff.identity.provisioned',$1,$2,$3)",
      [
        randomUUID(),
        input.reason,
        JSON.stringify({
          email: input.email.toLowerCase(),
          subject: input.subject,
          active: input.active,
          permissions: input.permissions,
          operator: input.operator,
        }),
      ],
    );
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
    await pool.end();
  }
}
