import { randomUUID } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { IdentityError } from '#modules/identity/domain/context';
import type {
  Organization,
  Membership,
} from '#modules/identity/domain/context';
import type { IdentityRepository } from '#modules/identity/application/identity';
import { createAuth } from '#modules/identity/infrastructure/auth';
import type { AuthSettings } from '#modules/identity/infrastructure/auth';
import * as schema from '#modules/identity/infrastructure/schema';
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
const memberDto = (row: typeof schema.member.$inferSelect): Membership => {
  if (!['owner', 'admin', 'member'].includes(row.role))
    throw new IdentityError(403, 'FORBIDDEN', 'Unknown organization role');
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    role: row.role as Membership['role'],
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
export function createRepository(pool: Pool, settings: AuthSettings) {
  const db = drizzle(pool, { schema });
  const auth = createAuth(db, settings);
  const repository: IdentityRepository = {
    async getSession(credentials) {
      const session = await auth.api.getSession({
        headers: new Headers(credentials),
        query: { disableCookieCache: true },
      });
      return session
        ? { userId: session.user.id, sessionId: session.session.id }
        : null;
    },
    async withUser(userId, operation) {
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.user_id', ${userId}, true)`,
          );
          return operation({
            async findMembership(organizationId) {
              const [row] = await tx
                .select()
                .from(schema.member)
                .where(
                  and(
                    eq(schema.member.organizationId, organizationId),
                    eq(schema.member.userId, userId),
                  ),
                );
              return row ? memberDto(row) : null;
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
                .select({ organization: schema.organization })
                .from(schema.member)
                .innerJoin(
                  schema.organization,
                  eq(schema.member.organizationId, schema.organization.id),
                )
                .where(eq(schema.member.userId, userId));
              return rows.map((row) => organizationDto(row.organization));
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
              return (
                await tx
                  .select()
                  .from(schema.member)
                  .where(eq(schema.member.organizationId, organizationId))
              ).map(memberDto);
            },
            async addMember(organizationId, newUserId, role) {
              const [row] = await tx
                .insert(schema.member)
                .values({
                  id: randomUUID(),
                  organizationId,
                  userId: newUserId,
                  role,
                  createdAt: new Date(),
                })
                .returning();
              return memberDto(row!);
            },
            async updateMember(organizationId, memberId, role) {
              const [row] = await tx
                .update(schema.member)
                .set({ role })
                .where(
                  and(
                    eq(schema.member.organizationId, organizationId),
                    eq(schema.member.id, memberId),
                  ),
                )
                .returning();
              if (!row)
                throw new IdentityError(404, 'NOT_FOUND', 'Member not found');
              return memberDto(row);
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
