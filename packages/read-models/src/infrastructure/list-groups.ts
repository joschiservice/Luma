import type {
  CollectionGroupKey,
  CollectionGroupResult,
} from '../application/collections.js';
import {
  type CollectionGroupRequest,
  groupJoin,
  groupOrder,
} from './collection/group.js';
import { maxCollectionGroups } from './collection/request.js';
import type { CollectionCompileContext } from './collection/where.js';
import type { ListPosition } from './list-paging.js';

/**
 * CTEs `group_members`, `group_list` and `group_heads` for lists that order every match before
 * paging with `listKeyset`: each row of `relation` (aliased `o`) once per group key with its
 * rank inside the group, the groups in display order with exact counts (at most
 * `maxCollectionGroups + 1`, so callers can report that more exist), and each listed group's first
 * `perGroup` rows. `order` is a `listKeyset` result without a cursor; `id` is the row ID.
 * Select the result with `rankedGroupsJson` and the head rows with `rankedGroupHeadIds`.
 */
export function rankedGroupCtes(
  relation: string,
  id: string,
  request: CollectionGroupRequest,
  order: { orderBy: string; position: string },
  perGroup: string,
  context: CollectionCompileContext,
) {
  return `group_members AS MATERIALIZED (
 SELECT ${id} AS id,g.key,${order.position},row_number() OVER (PARTITION BY g.key ORDER BY ${order.orderBy}) AS group_rank
 FROM ${relation} o ${groupJoin(request, context)}
), group_list AS MATERIALIZED (
 SELECT g.key,g.count,row_number() OVER (ORDER BY ${groupOrder(request.field, context.parameters)}) AS group_position
 FROM (SELECT key,count(*)::int AS count FROM group_members GROUP BY key) g ORDER BY group_position LIMIT ${maxCollectionGroups + 1}
), group_heads AS MATERIALIZED (
 SELECT m.* FROM group_members m JOIN group_list l ON l.key IS NOT DISTINCT FROM m.key
 WHERE l.group_position<=${maxCollectionGroups} AND m.group_rank<=${perGroup}
)`;
}

/** Selects the groups of `rankedGroupCtes` as one JSON array in display order. */
export const rankedGroupsJson = `COALESCE((SELECT jsonb_agg(jsonb_build_object('key',to_jsonb(l.key),'count',l.count,
 'head',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',h.id,'rank',h.list_rank,'keys',h.list_keys) ORDER BY h.group_rank)
  FROM group_heads h WHERE h.key IS NOT DISTINCT FROM l.key),'[]'::jsonb)) ORDER BY l.group_position)
 FROM group_list l),'[]'::jsonb)`;

/** Row IDs of every listed group's first rows, for loading the rows a grouped read shows. */
export const rankedGroupHeadIds = 'SELECT DISTINCT id FROM group_heads';

/** One group as `rankedGroupsJson` returns it. */
export interface RankedGroupRow {
  key: CollectionGroupKey;
  count: number;
  head: { id: string; rank: boolean; keys: string[] | null }[];
}

/**
 * Converts grouped rows into results. A group with more rows than its head gets a cursor for
 * the rest, written by `cursor` from the last head row's list position. Returns at most
 * `maxCollectionGroups` groups and whether more exist. Counts are exact, so every group is complete.
 */
export function rankedGroupResults(
  rows: RankedGroupRow[],
  cursor: (key: CollectionGroupKey, last: ListPosition) => string,
): { groups: CollectionGroupResult[]; truncated: boolean } {
  return {
    groups: rows.slice(0, maxCollectionGroups).map((row) => {
      const last = row.head.at(-1);

      return {
        key: row.key,
        count: row.count,
        complete: true,
        itemIds: row.head.map((item) => item.id),
        nextCursor:
          last && row.count > row.head.length
            ? cursor(row.key, {
                rank: last.rank ? 1 : 0,
                keys: last.keys,
                ids: [last.id],
              })
            : null,
        sums: [],
      };
    }),
    truncated: rows.length > maxCollectionGroups,
  };
}
