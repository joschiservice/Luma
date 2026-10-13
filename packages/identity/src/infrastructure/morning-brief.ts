import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { MorningBriefSource } from '../application/morning-brief.js';
import { morningBriefClock } from '../application/morning-brief.js';
import { makeTenantContext } from '../domain/context.js';
import {
  membershipFromRow,
  type MembershipRow,
  membershipSelect,
} from './access.js';
import { workspaceTransaction } from './settings.js';

/** Identifies the effective grants that authorize a queued snapshot; changes cancel delivery. */
export function briefAuthority(member: MembershipRow) {
  return JSON.stringify([
    member.role,
    member.customRoleId,
    member.roleRevision,
    member.permissions,
  ]);
}

/**
 * Queues one bounded report per opted-in member and workspace-local day. Reads happen outside
 * operational locks. The enqueue rechecks membership, grants, preference revision and timezone;
 * concurrent schedulers converge on the existing mail queue's unique event key. Empty reports
 * retain a cancelled queue receipt so later passes do not repeatedly reread the same day.
 */
export function createMorningBriefScheduler(
  pool: Pool,
  source: MorningBriefSource,
) {
  return async (asOf = new Date()) => {
    const tenants = await pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM morning_brief_tenants($1)',
      [asOf.toISOString()],
    );
    for (const { tenant_id: tenantId } of tenants.rows) {
      if (!(await source.enabled(tenantId))) continue;
      const candidates = await workspaceTransaction(
        pool,
        tenantId,
        '',
        async (tx) => {
          const workspace = (
            await tx.query<{ name: string; slug: string; timeZone: string }>(
              `SELECT o.name,o.slug,COALESCE(s.timezone,'UTC') AS "timeZone" FROM organizations o
           LEFT JOIN workspace_settings s ON s.tenant_id=o.id WHERE o.id=$1`,
              [tenantId],
            )
          ).rows[0]!;
          const clock = morningBriefClock(asOf, workspace.timeZone);
          const members = await tx.query<MembershipRow>(
            `${membershipSelect} JOIN notification_preferences n ON n.tenant_id=m.tenant_id AND n.user_id=m.user_id
           WHERE m.tenant_id=$1 AND m.status='active' AND n.morning_brief AND n.morning_brief_time<=$2
           AND NOT EXISTS (SELECT FROM workspace_mail q WHERE q.tenant_id=m.tenant_id AND q.event_key='morning-brief:'||m.user_id::text||':'||$3)
           AND NOT EXISTS (SELECT FROM account_disablements d WHERE d.user_id=m.user_id)
           LIMIT 100`,
            [tenantId, clock.time, clock.day],
          );
          const preferences = await tx.query<{
            user_id: string;
            revision: number;
            start: Date;
          }>(
            `SELECT p.user_id,p.revision,COALESCE(
            (SELECT (q.brief_document->'content'->>'end')::timestamptz FROM workspace_mail q
             WHERE q.tenant_id=p.tenant_id AND q.user_id=p.user_id AND q.kind='morning_brief' AND q.brief_document IS NOT NULL
             AND (q.brief_document->'content'->>'end')::timestamptz<$3::timestamptz ORDER BY (q.brief_document->'content'->>'end')::timestamptz DESC LIMIT 1),
            (((($3::timestamptz AT TIME ZONE $2)::date-1)::timestamp) AT TIME ZONE $2)) AS start
           FROM notification_preferences p WHERE p.tenant_id=$1 AND p.morning_brief AND p.user_id=ANY($4::uuid[])`,
            [
              tenantId,
              workspace.timeZone,
              asOf.toISOString(),
              members.rows.map((member) => member.userId),
            ],
          );

          return {
            workspace,
            clock,
            members: members.rows.map((member) => ({
              ...member,
              preferenceRevision: preferences.rows.find(
                (p) => p.user_id === member.userId,
              )!.revision,
              start: preferences.rows.find((p) => p.user_id === member.userId)!
                .start,
            })),
          };
        },
      );
      for (const member of candidates.members) {
        const context = makeTenantContext(
          { userId: member.userId, sessionId: 'morning-brief' },
          {
            id: tenantId,
            name: candidates.workspace.name,
            slug: candidates.workspace.slug,
            status: 'active',
            dataRegion: 'EU',
          },
          membershipFromRow(member),
          randomUUID(),
        );
        // A failed reader leaves no receipt, allowing the next pass to recover without false zeros.
        const content = await source.read(context, asOf, member.start);
        await workspaceTransaction(
          pool,
          tenantId,
          member.userId,
          async (tx) => {
            const current = (
              await tx.query<MembershipRow>(
                `${membershipSelect} WHERE m.tenant_id=$1 AND m.user_id=$2`,
                [tenantId, member.userId],
              )
            ).rows[0];
            const preference = (
              await tx.query<{ revision: number; timezone: string }>(
                `SELECT p.revision,COALESCE(s.timezone,'UTC') AS timezone FROM notification_preferences p
             LEFT JOIN workspace_settings s ON s.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND p.user_id=$2 AND p.morning_brief`,
                [tenantId, member.userId],
              )
            ).rows[0];
            if (
              !current ||
              current.status !== 'active' ||
              current.accountDisabled ||
              briefAuthority(current) !== briefAuthority(member) ||
              !preference ||
              preference.revision !== member.preferenceRevision ||
              preference.timezone !== candidates.workspace.timeZone
            )
              return;
            await tx.query(
              `INSERT INTO workspace_mail(tenant_id,id,event_key,kind,user_id,state,brief_document)
             VALUES($1,$2,$3,'morning_brief',$4,$5,$6) ON CONFLICT(tenant_id,event_key) DO NOTHING`,
              [
                tenantId,
                randomUUID(),
                `morning-brief:${member.userId}:${candidates.clock.day}`,
                member.userId,
                content ? 'queued' : 'cancelled',
                content
                  ? JSON.stringify({
                      content,
                      authority: briefAuthority(member),
                      day: candidates.clock.day,
                    })
                  : null,
              ],
            );
          },
        );
      }
    }
  };
}
