import type { SqlTransaction } from '@luma/platform';

import type {
  CustomerDetail,
  CustomerListItem,
  CustomerQuery,
  CustomerSource,
} from '../../application/customers.js';

const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Selects one `customer_profiles` row, aliased `p`, in the shape of a list item. */
const itemColumns = `p.id,p.connection_id AS "connectionId",p.external_id AS "externalId",
 p.display_name AS "displayName",p.email,p.phone,p.state,${iso('p.source_created_at')} AS "sourceCreatedAt",
 p.order_count AS "orderCount",
 CASE WHEN p.amount_spent IS NULL THEN NULL
  ELSE jsonb_build_object('amount',trim_scale(p.amount_spent)::text,'currency',p.currency) END AS "amountSpent",
 p.tags,jsonb_build_object('contact',p.contact_shared,'address',p.address_shared) AS shared,
 ${iso('p.source_updated_at')} AS "sourceUpdatedAt",${iso('p.observed_at')} AS "observedAt"`;

// Missing values sort as the lowest key so every profile has a position.
const sortKeys = {
  created: {
    key: `COALESCE(p.source_created_at,'-infinity'::timestamptz)`,
    type: 'timestamptz',
  },
  orders: { key: 'COALESCE(p.order_count,-1)', type: 'integer' },
  name: { key: `COALESCE(lower(p.display_name),'')`, type: 'text' },
} as const;

/** Position of the last row on a page in the requested order. */
export interface CustomerPosition {
  key: string;
  id: string;
}

/**
 * Lists up to `limit + 1` profiles for the filters after `after`, with the number of matches.
 * Search matches the name, email address and phone number anywhere, and the source customer ID
 * exactly or by its last path segment.
 */
export async function readCustomers(
  tx: SqlTransaction,
  tenantId: string,
  query: CustomerQuery,
  after: CustomerPosition | null,
) {
  const q = query.q.trim();
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = `p.tenant_id=$1 AND ($2::uuid IS NULL OR p.connection_id=$2)
   AND ($3::text IS NULL OR p.state=$3) AND ($4::text IS NULL OR p.external_id=$4)
   AND ($5='' OR p.display_name ILIKE $6 OR p.email ILIKE $6 OR p.phone ILIKE $6
    OR p.external_id=$5 OR right(p.external_id,length($5)+1)='/'||$5)`;
  const filters = [
    tenantId,
    query.connectionId ?? null,
    query.state ?? null,
    query.externalId ?? null,
    q,
    pattern,
  ];
  const count = await tx.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM customer_profiles p WHERE ${where}`,
    filters,
  );
  const { key, type } = sortKeys[query.sort];
  const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
  const rows = await tx.query<CustomerListItem & { position: string }>(
    `SELECT ${itemColumns},${key}::text AS position FROM customer_profiles p
     WHERE ${where} AND ($7::text IS NULL
      OR (${key},p.id) ${direction === 'ASC' ? '>' : '<'} ($7::${type},$8::uuid))
     ORDER BY ${key} ${direction},p.id ${direction} LIMIT $9`,
    [...filters, after?.key ?? null, after?.id ?? null, query.limit + 1],
  );

  return {
    rows: rows.rows.map(({ position, ...item }) => ({ position, item })),
    totalCount: count.rows[0]?.count ?? 0,
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
