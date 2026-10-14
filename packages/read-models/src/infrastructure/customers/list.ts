import type { TenantContext } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';

import type {
  CustomerDetail,
  CustomerListItem,
  CustomerQuery,
  CustomerSource,
} from '../../application/customers.js';
import type { CollectionCursorPosition } from '../collection/cursor.js';
import {
  collectionCustomFields,
  customFieldIds,
  customSort,
} from '../collection/custom-fields.js';
import {
  type CollectionGroupRow,
  groupCtes,
  groupHeadIds,
  groupMemberPredicate,
  groupsJson,
} from '../collection/group.js';
import {
  type CollectionOrdering,
  keysetCandidates,
  sortOrder,
} from '../collection/keyset.js';
import { likePattern } from '../collection/parameters.js';
import {
  collectionContext,
  collectionGrouping,
  collectionGroupLimit,
  maxCollectionGroups,
} from '../collection/request.js';
import { compileWhere } from '../collection/where.js';
import {
  customerCollectionFields,
  customerGroupFields,
  customerSorts,
} from './collection-fields.js';

const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * Selects one `customer_profiles` row, aliased `p`, in the shape of a list item. Whether full
 * reads still find the customer comes from the sync ledger, where every source records
 * customers as unscoped `customer` resources.
 */
const itemColumns = `p.id,p.connection_id AS "connectionId",p.external_id AS "externalId",
 p.display_name AS "displayName",p.email,p.phone,p.state,${iso('p.source_created_at')} AS "sourceCreatedAt",
 p.order_count AS "orderCount",
 CASE WHEN p.amount_spent IS NULL THEN NULL
  ELSE jsonb_build_object('amount',trim_scale(p.amount_spent)::text,'currency',p.currency) END AS "amountSpent",
 p.tags,jsonb_build_object('contact',p.contact_shared,'address',p.address_shared) AS shared,
 CASE WHEN p.address_shared THEN p.country END AS country,${iso('p.last_order_at')} AS "lastOrderAt",
 ${iso('p.source_updated_at')} AS "sourceUpdatedAt",${iso('p.observed_at')} AS "observedAt",
 (SELECT ${iso('i.missing_since')} FROM commerce_sync_items i WHERE i.tenant_id=p.tenant_id
  AND i.connection_id=p.connection_id AND i.record_type='customers' AND i.resource='customer'
  AND i.scope_key='' AND i.external_id=p.external_id) AS "missingSince"`;

/** One page of profiles, or every group's first rows, with the number of matches. */
export interface CustomerPage {
  rows: { item: CustomerListItem; position: CollectionCursorPosition }[];
  totalCount: number;
  groups: CollectionGroupRow[] | null;
}

function isNativeSort(sort: string): sort is keyof typeof customerSorts {
  return Object.hasOwn(customerSorts, sort);
}

/**
 * Lists up to `limit + 1` profiles for the filters and conditions after `after`, or with
 * `group` every group's count and first rows, with the number of matches. Search matches the
 * name, email address and phone number anywhere, and the source customer ID exactly or by its
 * last path segment. Conditions and the sort may name readable custom customer fields.
 * Relative dates resolve against `asOf`. Throws a 400 error for invalid conditions, grouping
 * or unavailable custom fields, and a 403 error for custom fields the reader may not read.
 */
export async function readCustomers(
  tx: SqlTransaction,
  tenant: TenantContext,
  query: CustomerQuery,
  asOf: string,
  after: CollectionCursorPosition | null,
): Promise<CustomerPage> {
  const q = query.q.trim();
  const values: unknown[] = [
    tenant.tenantId,
    query.connectionId ?? null,
    query.state ?? null,
    query.externalId ?? null,
    q,
    likePattern(q),
  ];
  const context = collectionContext(
    values,
    asOf,
    query.timeZone,
    tenant.actor.id,
  );
  const { parameters } = context;
  const customIds = customFieldIds([
    ...(query.where?.conditions.map((condition) => condition.field) ?? []),
    query.sort,
  ]);
  const custom = customIds.length
    ? await collectionCustomFields(
        tx,
        tenant,
        { type: 'customer', id: 'o.id' },
        customIds,
        parameters,
        context.timeZone,
      )
    : undefined;
  const where = query.where?.conditions.length
    ? compileWhere(
        query.where,
        { ...customerCollectionFields, ...custom?.fields },
        context,
      ).sql
    : 'true';
  const { request, grouped } = collectionGrouping(query, customerGroupFields);
  const member =
    request && query.groupKey !== undefined
      ? groupMemberPredicate(request, query.groupKey, context)
      : 'true';
  const ordering: CollectionOrdering = {
    sort: isNativeSort(query.sort)
      ? customerSorts[query.sort]
      : customSort(custom?.sorts, query.sort),
    direction: query.direction,
    id: 'o.id',
  };
  let page: string;
  let groups = 'NULL::jsonb';
  let ctes = '';
  if (request && grouped) {
    ctes = `${groupCtes(
      'filtered',
      request,
      ordering,
      parameters.bind(collectionGroupLimit(query), 'integer'),
      maxCollectionGroups,
      { field: 'spent', amount: 'o.amount_spent', currency: 'o.currency' },
      context,
    )},`;
    groups = groupsJson;
    page = `SELECT o.*,0 AS sort_rank,'{}'::text[] AS sort_keys,0::bigint AS n FROM filtered o
 WHERE o.id IN (SELECT id::uuid FROM (${groupHeadIds}) h)`;
  } else {
    const limit = parameters.bind(query.limit + 1, 'integer');
    page = `SELECT o.*,row_number() OVER (ORDER BY ${sortOrder(ordering)}) AS n FROM (${keysetCandidates(
      'filtered',
      ordering,
      limit,
      {
        rank: parameters.bind(after?.rank ?? null, 'integer'),
        keys: parameters.bind(after?.keys ?? null, 'text[]'),
        id: parameters.bind(after?.id ?? null, 'uuid'),
      },
    )}) o ORDER BY ${sortOrder(ordering)} LIMIT ${limit}`;
  }
  const result = await tx.query<{
    total: number;
    page: (CustomerListItem & {
      sortRank: 0 | 1;
      sortKeys: (string | null)[];
    })[];
    groups: CollectionGroupRow[] | null;
  }>(
    `WITH filtered AS NOT MATERIALIZED (
  SELECT o.* FROM customer_profiles o
  WHERE o.tenant_id=$1 AND ($2::uuid IS NULL OR o.connection_id=$2)
   AND ($3::text IS NULL OR o.state=$3) AND ($4::text IS NULL OR o.external_id=$4)
   AND ($5='' OR o.display_name ILIKE $6 OR o.email ILIKE $6 OR o.phone ILIKE $6
    OR o.external_id=$5 OR right(o.external_id,length($5)+1)='/'||$5)
   AND ${where} AND ${member}
), ${ctes} page AS MATERIALIZED (${page})
SELECT (SELECT count(*) FROM filtered)::int AS total,
 COALESCE((SELECT jsonb_agg(to_jsonb(i)-'n' ORDER BY i.n,i.id) FROM (
  SELECT ${itemColumns},p.sort_rank AS "sortRank",p.sort_keys AS "sortKeys",p.n FROM page p) i),'[]') AS page,
 ${groups} AS groups`,
    values,
  );
  const row = result.rows[0]!;

  return {
    rows: row.page.map(({ sortRank, sortKeys, ...item }) => ({
      position: { rank: sortRank, keys: sortKeys, id: item.id },
      item,
    })),
    totalCount: row.total,
    groups: row.groups,
  };
}

/** Reads one profile with its address, or null when the tenant has none with this ID. */
export async function readCustomer(
  tx: SqlTransaction,
  tenantId: string,
  id: string,
) {
  const result = await tx.query<
    CustomerListItem & { address: CustomerDetail['address'] }
  >(
    `SELECT ${itemColumns},p.address FROM customer_profiles p WHERE p.tenant_id=$1 AND p.id=$2`,
    [tenantId, id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const { address, ...item } = row;

  return { item, address };
}

/**
 * Lists commerce connections with whether they share customers, how many profiles Luma holds
 * and the state of their customer sync. Connections that read orders are included even without
 * customers, so missing access is visible.
 */
export async function readCustomerSources(
  tx: SqlTransaction,
  tenantId: string,
  connectionId?: string,
) {
  const result = await tx.query<CustomerSource>(
    `WITH counted AS (SELECT connection_id,count(*)::int AS records FROM customer_profiles
      WHERE tenant_id=$1 AND ($2::uuid IS NULL OR connection_id=$2) GROUP BY connection_id)
     SELECT c.id AS "connectionId",COALESCE(c.document->>'label',c.document->'target'->>'kind','Connected source') AS label,
      COALESCE(c.document->>'provider',c.document->'target'->>'kind') AS system,c.document->>'appId' AS "appId",
      COALESCE(c.document->>'status','unknown') AS status,
      CASE WHEN c.document->'granted' ? 'customers.read' THEN 'granted'
       WHEN c.document->'permissions' ? 'customers.read' THEN 'not_granted' ELSE 'not_requested' END AS access,
      COALESCE(n.records,0) AS records,COALESCE(st.phase='backfill',false) AS importing,
      ${iso('st.last_full_scan_at')} AS "fullReadAt",${iso('st.last_success_at')} AS "lastReadAt",
      st.error_code IS NOT NULL AS failing
     FROM connector_installations c
     LEFT JOIN counted n ON n.connection_id=c.id
     LEFT JOIN commerce_sync_streams st ON st.tenant_id=c.tenant_id AND st.connection_id=c.id AND st.record_type='customers'
     WHERE c.tenant_id=$1 AND ($2::uuid IS NULL OR c.id=$2) AND (n.connection_id IS NOT NULL
      OR (c.document->'permissions' ? 'orders.read' AND c.document->>'status' NOT IN ('disconnected','revoked')))
     ORDER BY label,c.id`,
    [tenantId, connectionId ?? null],
  );

  return result.rows;
}
