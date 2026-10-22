import { ServiceError } from '@luma/platform';
import type { Pool } from 'pg';

import type { IdentityRepository } from '../application/identity.js';
import type { Organization } from '../domain/context.js';
import type { MembershipRow } from './access.js';
import { membershipFromRow, membershipSelect } from './access.js';
import type * as schema from './schema.js';

/** Maps a stored organization; unknown placement or status fails closed as unavailable. */
export const organizationDto = (
  row: typeof schema.organization.$inferSelect,
): Organization => {
  if (
    !['EU', 'AU', 'US'].includes(row.dataRegion) ||
    !['active', 'suspended', 'closed'].includes(row.status)
  )
    throw new ServiceError(
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

/** Reads a tenant's region through the placement directory; returns no other tenant data. */
export function createPlacement(
  pool: Pool,
): NonNullable<IdentityRepository['placement']> {
  return {
    async regionForTenant(tenantId) {
      const result = await pool.query<{
        region: Organization['dataRegion'] | null;
      }>('SELECT identity_tenant_region($1) AS region', [tenantId]);

      return result.rows[0]?.region ?? null;
    },
  };
}

/**
 * Reads, as the user, their membership in one organization, the organization and whether the
 * account was erased, in one transaction.
 */
export function createMemberLookup(pool: Pool): IdentityRepository['memberOf'] {
  return async (userId, organizationId) => {
    const client = await pool.connect();
    try {
      // One round trip opens the transaction as the user; several statements take no
      // parameters, so the user ID is an escaped literal.
      await client.query(
        `BEGIN; SELECT set_config('app.user_id', ${client.escapeLiteral(userId)}, true)`,
      );
      const { rows } = await client.query<{
        member: MembershipRow | null;
        organization: typeof schema.organization.$inferSelect | null;
        erased: boolean;
      }>(
        `SELECT (SELECT to_jsonb(m) FROM (${membershipSelect} WHERE m.tenant_id=$1 AND m.user_id=$2) m) AS member,
          (SELECT jsonb_build_object('id',o.id,'name',o.name,'slug',o.slug,'dataRegion',o.data_region,'status',o.status)
            FROM organizations o WHERE o.id=$1) AS organization,
          EXISTS(SELECT 1 FROM account_deletions WHERE user_id=$2 AND status='erased') AS erased`,
        [organizationId, userId],
      );
      await client.query('COMMIT');
      const [row] = rows;

      return {
        member: row?.member ? membershipFromRow(row.member) : null,
        organization: row?.organization
          ? organizationDto(row.organization)
          : null,
        erased: row?.erased ?? false,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}
