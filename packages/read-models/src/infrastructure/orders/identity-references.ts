import type { SqlTransaction } from '@luma/platform';

/** Resolves a retired order or child through tenant-scoped redirects; cycles are rejected. */
export async function resolveOrderEntity(
  tx: SqlTransaction,
  tenantId: string,
  id: string,
) {
  const result = await tx.query<{ id: string; cycle: boolean }>(
    `WITH RECURSIVE path(id,visited,cycle) AS (
      SELECT $2::uuid,ARRAY[$2::uuid],false
      UNION ALL SELECT r.target_entity_id,p.visited||r.target_entity_id,r.target_entity_id=ANY(p.visited)
       FROM path p JOIN orders_entity_redirects r ON r.tenant_id=$1 AND r.entity_id=p.id WHERE NOT p.cycle
    ) SELECT id,cycle FROM path ORDER BY cardinality(visited) DESC LIMIT 1`,
    [tenantId, id],
  );
  if (result.rows[0]?.cycle) throw new Error('Order redirect cycle');

  return result.rows[0]?.id ?? id;
}

/** Retired identities that still resolve to these records, for cases, activity and provenance. */
export async function orderEntityAliases(
  tx: SqlTransaction,
  tenantId: string,
  ids: string[],
) {
  return (
    await tx.query<{ id: string }>(
      `WITH RECURSIVE aliases(id) AS (
      SELECT unnest($2::uuid[])
      UNION SELECT r.entity_id FROM aliases a JOIN orders_entity_redirects r ON r.tenant_id=$1 AND r.target_entity_id=a.id
    ) SELECT id FROM aliases ORDER BY id`,
      [tenantId, ids],
    )
  ).rows.map((row) => row.id);
}
