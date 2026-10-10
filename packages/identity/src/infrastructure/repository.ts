import { randomUUID } from 'node:crypto';

import { APIError } from 'better-auth/api';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import type { IdentityRepository, MemberDto } from '../application/identity.js';
import type { Organization } from '../domain/context.js';
import { IdentityError } from '../domain/context.js';
import {
  builtInReference,
  isBuiltInRole,
  PermissionSet,
} from '../domain/roles.js';
import {
  sessionActivityDue,
  sessionActivityIntervalMs,
} from '../domain/sessions.js';
import type { MembershipRow } from './access.js';
import { membershipFromRow, membershipSelect, storedRole } from './access.js';
import type { AuthSettings } from './auth.js';
import { createAuth } from './auth.js';
import * as schema from './schema.js';
import { listSecurityEvents, securityEventsPlugin } from './security-events.js';
import { createSupportViewCredentials } from './support-view.js';

const organizationDto = (
  row: typeof schema.organization.$inferSelect,
): Organization => {
  if (
    !['EU', 'US', 'APAC'].includes(row.dataRegion) ||
    !['active', 'suspended', 'closed'].includes(row.status)
  )
    throw new IdentityError(
      503,
      'REGION_UNAVAILABLE',
      'Organization placement is unavailable',
    );

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    dataRegion: row.dataRegion as Organization['dataRegion'],
    status: row.status as Organization['status'],
  };
};

function normalizeDatabaseError(error: unknown): never {
  if (
    error instanceof APIError &&
    error.body?.code === 'ORGANIZATION_ALREADY_EXISTS'
  ) {
    throw new IdentityError(
      409,
      'CONFLICT',
      'Organization or membership already exists',
    );
  }
  const cause = error instanceof Error && error.cause ? error.cause : error;
  const code =
    typeof cause === 'object' && cause && 'code' in cause
      ? cause.code
      : undefined;
  if (code === '23505')
    throw new IdentityError(
      409,
      'CONFLICT',
      'Organization or membership already exists',
    );
  if (code === '23503')
    throw new IdentityError(404, 'NOT_FOUND', 'User or member not found');
  throw error;
}

/**
 * Creates authentication and persistent session, organization, and membership operations
 * using the supplied pool.
 */
export function createRepository(pool: Pool, settings: AuthSettings) {
  const db = drizzle(pool, { schema });
  const auth = createAuth(db, settings, undefined, [
    securityEventsPlugin(pool, settings.secret),
  ]);
  const repository: IdentityRepository = {
    async getSession(credentials) {
      const session = await auth.api.getSession({
        headers: new Headers(credentials),
        query: { disableCookieCache: true },
      });

      if (!session) return null;
      if (sessionActivityDue(session.session.lastActiveAt, new Date()))
        // The SQL condition keeps concurrent requests from writing more than once per interval.
        await pool.query(
          `UPDATE sessions SET last_active_at=now() WHERE id=$1 AND (last_active_at IS NULL OR last_active_at<=now()-make_interval(secs=>$2))`,
          [session.session.id, sessionActivityIntervalMs / 1000],
        );

      return { userId: session.user.id, sessionId: session.session.id };
    },
    supportViews: createSupportViewCredentials(pool, settings),
    listSecurityEvents: (userId, after, limit) =>
      listSecurityEvents(pool, userId, after, limit),
    async withUser(userId, operation) {
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.user_id', ${userId}, true)`,
          );
          const readMember = async (
            organizationId: string,
            memberId: string,
          ) => {
            const result = await tx.execute<MembershipRow>(
              sql`${sql.raw(membershipSelect)} WHERE m.tenant_id=${organizationId} AND m.id=${memberId}`,
            );
            const row = result.rows[0];
            if (!row)
              throw new IdentityError(404, 'NOT_FOUND', 'Member not found');

            return membershipFromRow(row);
          };

          return operation({
            async findMembership(organizationId) {
              const result = await tx.execute<MembershipRow>(
                sql`${sql.raw(membershipSelect)} WHERE m.tenant_id=${organizationId} AND m.user_id=${userId}`,
              );
              const row = result.rows[0];

              return row ? membershipFromRow(row) : null;
            },
            async findOrganization(organizationId) {
              const [row] = await tx
                .select()
                .from(schema.organization)
                .where(eq(schema.organization.id, organizationId));

              return row ? organizationDto(row) : null;
            },
            async listOrganizations() {
              const rows = await tx
                .select({
                  organization: schema.organization,
                  status: schema.member.status,
                })
                .from(schema.member)
                .innerJoin(
                  schema.organization,
                  eq(schema.member.organizationId, schema.organization.id),
                )
                .where(eq(schema.member.userId, userId));

              return rows.map((row) => ({
                ...organizationDto(row.organization),
                membershipStatus:
                  row.status === 'active'
                    ? ('active' as const)
                    : ('suspended' as const),
              }));
            },
            async profile() {
              const [row] = await tx
                .select({ name: schema.user.name, email: schema.user.email })
                .from(schema.user)
                .where(eq(schema.user.id, userId));

              return row ?? null;
            },
            async createOrganization(input) {
              const id = randomUUID();
              await tx.execute(
                sql`select set_config('app.provision_id', ${id}, true)`,
              );
              const scopedAuth = createAuth(tx, settings, id);
              const created = await scopedAuth.api.createOrganization({
                body: { ...input, userId, keepCurrentActiveOrganization: true },
              });
              if (!created) throw new Error('Organization creation failed');
              const [row] = await tx
                .select()
                .from(schema.organization)
                .where(eq(schema.organization.id, created.id));
              if (!row) throw new Error('Created organization is unavailable');

              return organizationDto(row);
            },
            async selectTenant(organizationId) {
              await tx.execute(
                sql`select set_config('app.tenant_id', ${organizationId}, true)`,
              );
            },
            async lockOrganization(organizationId) {
              await tx
                .select({ id: schema.organization.id })
                .from(schema.organization)
                .where(eq(schema.organization.id, organizationId))
                .for('update');
            },
            async listMembers(organizationId) {
              const result = await tx.execute<
                MembershipRow & { name: string; email: string }
              >(
                sql`SELECT a.*,u.name,u.email FROM (${sql.raw(membershipSelect)} WHERE m.tenant_id=${organizationId}) a JOIN users u ON u.id=a."userId" ORDER BY lower(u.name),u.email`,
              );

              return result.rows.map((row) => ({
                ...membershipFromRow(row),
                name: row.name,
                email: row.email,
              }));
            },
            async suspendedMembers(organizationId, userIds) {
              const rows = await tx
                .select({ userId: schema.member.userId })
                .from(schema.member)
                .where(
                  and(
                    eq(schema.member.organizationId, organizationId),
                    eq(schema.member.status, 'suspended'),
                    inArray(schema.member.userId, [...userIds]),
                  ),
                );

              return rows.map((row) => row.userId);
            },
            async findRole(organizationId, roleId) {
              if (isBuiltInRole(roleId)) {
                const reference = builtInReference(roleId);

                return {
                  reference,
                  permissions: PermissionSet.forRole(reference),
                  archived: false,
                };
              }
              if (
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                  roleId,
                )
              )
                return null;
              const result = await tx.execute<{
                id: string;
                name: string;
                revision: number;
                archived: boolean;
                permissions: string[];
              }>(
                sql`SELECT r.id,r.name,r.revision,r.archived_at IS NOT NULL AS archived,
                  ARRAY(SELECT p.permission FROM workspace_role_permissions p WHERE p.tenant_id=r.tenant_id AND p.role_id=r.id) AS permissions
                  FROM workspace_roles r WHERE r.tenant_id=${organizationId} AND r.id=${roleId}`,
              );
              const row = result.rows[0];
              if (!row) return null;
              const reference = {
                id: row.id,
                key: 'custom' as const,
                name: row.name,
                builtIn: false,
                revision: row.revision,
              };

              return {
                reference,
                permissions: PermissionSet.forRole(reference, row.permissions),
                archived: row.archived,
              };
            },
            async memberCommand(organizationId, id) {
              const result = await tx.execute(
                sql`SELECT actor_id AS "actorId",request,result FROM workspace_commands WHERE tenant_id=${organizationId} AND id=${id}`,
              );

              return (
                (result.rows[0] as
                  | {
                      actorId: string;
                      request: string;
                      result: MemberDto | null;
                    }
                  | undefined) ?? null
              );
            },
            async saveMemberCommand(
              organizationId,
              id,
              actorId,
              request,
              result,
            ) {
              await tx.execute(
                sql`INSERT INTO workspace_commands(tenant_id,id,actor_id,request,result) VALUES(${organizationId},${id},${actorId},${JSON.stringify(request)}::jsonb,${JSON.stringify(result)}::jsonb)`,
              );
            },
            async auditMember(organizationId, actorId, action, before, after) {
              await tx.execute(
                sql`INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id,before_value,after_value) VALUES(${randomUUID()},${organizationId},${actorId},${`member.${action}`},${after?.id ?? before!.id},${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb)`,
              );
            },
            async addMember(organizationId, newUserId, roleId) {
              const stored = storedRole(roleId);
              const [row] = await tx
                .insert(schema.member)
                .values({
                  id: randomUUID(),
                  organizationId,
                  userId: newUserId,
                  role: stored.role,
                  customRoleId: stored.customRoleId,
                  createdAt: new Date(),
                })
                .returning({ id: schema.member.id });

              return readMember(organizationId, row!.id);
            },
            async updateMember(organizationId, memberId, roleId) {
              const stored = storedRole(roleId);
              const [row] = await tx
                .update(schema.member)
                .set({ role: stored.role, customRoleId: stored.customRoleId })
                .where(
                  and(
                    eq(schema.member.organizationId, organizationId),
                    eq(schema.member.id, memberId),
                  ),
                )
                .returning({ id: schema.member.id });
              if (!row)
                throw new IdentityError(404, 'NOT_FOUND', 'Member not found');

              return readMember(organizationId, row.id);
            },
            async removeMember(organizationId, memberId) {
              await tx
                .delete(schema.member)
                .where(
                  and(
                    eq(schema.member.organizationId, organizationId),
                    eq(schema.member.id, memberId),
                  ),
                );
            },
          });
        });
      } catch (error) {
        return normalizeDatabaseError(error);
      }
    },
  };

  return { repository, auth };
}
