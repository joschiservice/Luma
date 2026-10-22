import type { Pool } from 'pg';

import type {
  IdentityRepository,
  IdentityTransaction,
} from '../application/identity.js';
import type { MembershipRow } from './access.js';
import { membershipFromRow, membershipSelect } from './access.js';
import { createMemberLookup, createPlacement } from './member-lookup.js';

function unavailable(): never {
  throw new Error('Background workers can only read workspace members');
}

const memberChanges = {
  memberCommand: unavailable,
  saveMemberCommand: unavailable,
  auditMember: unavailable,
  findRole: unavailable,
  listOrganizations: unavailable,
  profile: unavailable,
  findMembership: unavailable,
  accountErased: unavailable,
  findOrganization: unavailable,
  createOrganization: unavailable,
  lockOrganization: unavailable,
  addMember: unavailable,
  updateMember: unavailable,
  removeMember: unavailable,
} satisfies Partial<IdentityTransaction>;

/**
 * Creates the identity reads background workers need on a login with `luma_workflow_identity`:
 * placement, a user's membership in a workspace and the selected workspace's members, without
 * names or emails. Sessions, credentials, support views and member changes throw.
 */
export function createWorkflowIdentityRepository(
  pool: Pool,
): IdentityRepository {
  return {
    placement: createPlacement(pool),
    memberOf: createMemberLookup(pool),
    getSession: unavailable,
    supportViews: {
      token: unavailable,
      cookie: unavailable,
      resolve: unavailable,
      redeem: unavailable,
      end: unavailable,
      sweep: unavailable,
    },
    accountInspections: {
      list: unavailable,
      decide: unavailable,
      revoke: unavailable,
    },
    listSecurityEvents: unavailable,
    setLanguage: unavailable,
    async withUser(userId, operation) {
      const client = await pool.connect();
      try {
        await client.query(
          `BEGIN READ ONLY; SELECT set_config('app.user_id', ${client.escapeLiteral(userId)}, true)`,
        );
        const result = await operation({
          ...memberChanges,
          async selectTenant(organizationId) {
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [
              organizationId,
            ]);
          },
          async listMembers(organizationId) {
            const { rows } = await client.query<MembershipRow>(
              `${membershipSelect} WHERE m.tenant_id=$1 ORDER BY m.id`,
              [organizationId],
            );

            return rows.map(membershipFromRow);
          },
          async suspendedMembers(organizationId, userIds) {
            const { rows } = await client.query<{ user_id: string }>(
              `SELECT m.user_id FROM memberships m WHERE m.tenant_id=$1 AND m.user_id=ANY($2::uuid[])
                AND (m.status='suspended' OR EXISTS(SELECT FROM account_disablements d WHERE d.user_id=m.user_id))
              UNION SELECT user_id FROM account_deletions WHERE status='erased' AND user_id=ANY($2::uuid[])`,
              [organizationId, [...userIds]],
            );

            return rows.map((row) => row.user_id);
          },
        });
        await client.query('COMMIT');

        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
