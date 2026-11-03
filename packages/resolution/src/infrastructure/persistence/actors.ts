import type { SqlTransaction } from '@luma/platform';
import { sqlUuid } from '@luma/platform';

import type { ActivityActor } from '../../domain/activity.js';

/**
 * Builds the response actor from the recorded actor and the workspace person it names, read
 * from `row`'s actor_name, actor_email and actor_member columns. Former members keep the name
 * recorded when they left; a user without one is still a former member. Email is shown only
 * for current members. Luma records events without an actor that `luma` matches, and the nil
 * UUID stands for Luma where an actor is required. Rows that `support` matches were recorded by
 * Luma staff; they carry no personal ID.
 */
export const actorSql = (actor: {
  row: string;
  kind: string;
  id: string;
  luma: string;
  workflow: string;
  support?: string;
}) => `jsonb_build_object(
      'kind',CASE ${actor.support ? `WHEN ${actor.support} THEN 'support' ` : ''}WHEN ${actor.row}.actor_member THEN 'member'
        WHEN (${actor.id} IS NULL AND ${actor.luma}) OR ${actor.id}='00000000-0000-0000-0000-000000000000' THEN 'luma'
        WHEN ${actor.row}.actor_name IS NOT NULL OR (${actor.kind}='user' AND ${actor.id} IS NOT NULL) THEN 'former_member'
        WHEN ${actor.id} IS NOT NULL THEN 'service' ELSE 'unrecorded' END,
      'id',${actor.support ? `CASE WHEN ${actor.support} THEN NULL ELSE left(${actor.id},300) END` : `left(${actor.id},300)`},
      'name',left(COALESCE(${actor.row}.actor_name,CASE WHEN ${actor.kind}<>'user' THEN ${actor.id} END),200),
      'email',left(${actor.row}.actor_email,320),'workflow',${actor.workflow})`;

/**
 * A lateral join that reads the workspace person a recorded user ID names into `alias`, for use
 * with {@link actorSql}. Only canonical UUIDs can name a person.
 */
export const personSql = (alias: string, tenant: string, id: string) =>
  `LEFT JOIN LATERAL (SELECT name AS actor_name,email AS actor_email,is_member AS actor_member
    FROM workspace_people WHERE tenant_id=${tenant}
    AND user_id=${sqlUuid(id)}) ${alias} ON true`;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Reads the people behind recorded user IDs in one query, in first-seen order without
 * duplicates and at most 100. A user ID that names nobody in this workspace reads as a former
 * member without a name. Values that are not user IDs, such as an author named "Luma", are
 * skipped because they are names already.
 */
export async function readPeople(
  tx: SqlTransaction,
  tenantId: string,
  ids: readonly (string | null | undefined)[],
): Promise<ActivityActor[]> {
  const unique = [
    ...new Set(ids.filter((id): id is string => uuid.test(id ?? ''))),
  ].slice(0, 100);
  if (!unique.length) return [];
  const result = await tx.query<{ actor: ActivityActor }>(
    `SELECT ${actorSql({ row: 'p', kind: "'user'", id: 'i.id', luma: 'false', workflow: 'NULL' })} AS actor
     FROM unnest($2::text[]) WITH ORDINALITY i(id,position)
     ${personSql('p', '$1', 'i.id')}
     ORDER BY i.position`,
    [tenantId, unique],
  );

  return result.rows.map((row) => row.actor);
}
