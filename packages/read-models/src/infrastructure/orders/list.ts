import type { TenantContext } from '@luma/identity';
import { hasPermission } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';
import { unavailable } from '@luma/platform';

import type {
  OrderList,
  OrderListItem,
  OrderListQuery,
  OrderSort,
} from '../../application/orders.js';
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
  groupResults,
  groupsJson,
} from '../collection/group.js';
import {
  collectionQueryError,
  likePattern,
  SqlParameters,
} from '../collection/parameters.js';
import {
  type CollectionCompileContext,
  compileWhere,
} from '../collection/where.js';
import { adaptiveOrderSelection } from './adaptive-query.js';
import {
  freshStockHold,
  openFulfillment,
  orderCollectionFields,
  type OrderFieldPart,
  orderGroupFields,
  orderSorts,
} from './collection-fields.js';
import {
  cursorContext,
  groupCursorContext,
  readAdaptiveCursor,
  readCursor,
  writeAdaptiveCursor,
  writeCursor,
} from './cursor.js';
import { isLegacySort, legacyListSql } from './legacy-list-query.js';
import type { OrderPageMode, OrderReadQueries } from './list-query.js';
import { listSql } from './list-query.js';
import { orderCustomerSearchHits, orderSearchHits } from './search-query.js';
import { iso, money, source } from './values.js';

type ListRow = Omit<
  OrderListItem,
  'placedAt' | 'dueAt' | 'observedAt' | 'sourceUpdatedAt' | 'sources' | 'total'
> & {
  placedAt: string | null;
  dueAt: string | null;
  observedAt: string;
  sourceUpdatedAt: string | null;
  total: unknown;
  sources: Record<string, unknown>[];
  sortRank: 0 | 1;
  /** Native reads return every key; legacy reads one text key. */
  sortKeys?: (string | null)[];
  sortKey?: string;
};

/** Groups returned at most; a request learns from `groupsTruncated` that more exist. */
const maxGroups = 50;

/**
 * Current Luma orders whose source order the customer's connection attributes to this imported
 * customer. Linked orders appear once, under their current canonical ID.
 */
async function customerOrderIds(
  tx: SqlTransaction,
  tenantId: string,
  customerId: string,
) {
  const result = await tx.query<{ id: string }>(
    `SELECT DISTINCT m.canonical_id AS id FROM customer_profiles p
     JOIN customer_orders c ON c.tenant_id=p.tenant_id AND c.connection_id=p.connection_id
      AND c.customer_external_id=p.external_id
     JOIN connector_source_mappings m ON m.tenant_id=c.tenant_id AND m.connection_id=c.connection_id
      AND m.resource='order' AND m.scope_key=c.order_scope_key AND m.external_id=c.order_external_id
     WHERE p.tenant_id=$1 AND p.id=$2`,
    [tenantId, customerId],
  );

  return result.rows.map((row) => row.id);
}

/**
 * Reads one page of current orders and, when requested, the exact match count. With `group`,
 * reads every group's count and first rows instead, or one group's page with `groupKey`.
 * Throws a 400 error when the cursor was issued for another query or a condition is invalid,
 * and a 503 error for conditions, groups and new sorts while projections rebuild or source
 * access is restricted.
 */
export async function listOrders(
  tx: SqlTransaction,
  queries: OrderReadQueries,
  context: TenantContext,
  query: OrderListQuery,
  asOf: string,
  hiddenSources = false,
): Promise<OrderList> {
  const grouped = query.group !== undefined && query.groupKey === undefined;
  if (query.groupKey !== undefined && !query.group)
    throw collectionQueryError('Choose a grouping to read one group.');
  if (grouped && query.cursor)
    throw collectionQueryError(
      'Use a group’s page link together with its group key.',
    );
  if (query.group && query.adaptive)
    throw collectionQueryError(
      'Views with custom-field filters cannot be grouped.',
    );
  const scope =
    query.groupKey !== undefined
      ? groupCursorContext(context.tenantId, query, query.groupKey)
      : cursorContext(context.tenantId, query);
  const after =
    !query.adaptive && query.cursor ? readCursor(query.cursor, scope) : null;
  const search = query.q !== '';
  const rebuilding = await tx.query(
    'SELECT 1 FROM orders_list_backfill WHERE tenant_id=$1',
    [context.tenantId],
  );
  const legacy = !!rebuilding.rowCount || hiddenSources;
  if (
    legacy &&
    (query.adaptive ||
      query.locationId ||
      query.stockBlocked ||
      query.where?.conditions.length ||
      query.group ||
      !isLegacySort(query.sort))
  )
    throw unavailable(
      'Conditions, grouping, sorting by total, status, payment, fulfillment or lines, and warehouse and custom-field queries are unavailable while order projections rebuild or source access is restricted.',
    );
  const values: unknown[] = [
    context.tenantId,
    asOf,
    query.connectionId ?? null,
    query.status ?? null,
    query.paymentStatus ?? null,
    query.placedFrom ?? null,
    query.placedBefore ?? null,
    query.updatedFrom ?? null,
    query.updatedBefore ?? null,
    query.limit + 1,
    after?.rank ?? null,
    legacy ? (after?.keys[0] ?? null) : (after?.keys ?? null),
    after?.id ?? null,
  ];
  let searchPlan: false | 'selective' | 'broad' = false;
  const customerSearch = hasPermission(context, 'customers.read');
  if (search && !legacy) {
    // Use compact parameter numbers in this independent lookup; unused parameters have no SQL type.
    const hitsSql = orderSearchHits
      .replaceAll('$14', '$4')
      .replaceAll('$15', '$5');
    const hits = await tx.query<{ id: string }>(
      `WITH ${hitsSql} SELECT id FROM hits WHERE $2::timestamptz IS NOT NULL`,
      [
        context.tenantId,
        asOf,
        query.connectionId ?? null,
        query.q,
        likePattern(query.q),
      ],
    );
    // Customer names and emails match only for readers who can read customers.
    const customerHits = customerSearch
      ? await tx.query<{ id: string }>(
          orderCustomerSearchHits.replaceAll('$15', '$2'),
          [context.tenantId, likePattern(query.q), query.connectionId ?? null],
        )
      : { rows: [] };
    const ids = new Set(
      [...hits.rows, ...customerHits.rows].map(({ id }) => id),
    );
    searchPlan =
      hits.rows.length > 1000 ||
      customerHits.rows.length > 1000 ||
      ids.size > 1000
        ? 'broad'
        : 'selective';
    if (searchPlan === 'selective') values.push([...ids]);
    else values.push(query.q, likePattern(query.q));
  } else if (search) values.push(query.q, likePattern(query.q));
  let customer: number | undefined;
  if (query.customerId) {
    values.push(await customerOrderIds(tx, context.tenantId, query.customerId));
    customer = values.length;
  }
  const adaptiveOffset =
    query.adaptive && query.cursor
      ? readAdaptiveCursor(query.cursor, scope)
      : (query.adaptive?.offset ?? 0);
  const result =
    legacy && isLegacySort(query.sort)
      ? await tx.query<{
          totalCount: number | null;
          items: ListRow[];
          groups: null;
        }>(
          legacyListSql(
            queries,
            query.view,
            query.sort,
            query.direction,
            search,
            query.count === 'exact',
            customer,
          ),
          values,
        )
      : await tx.query<{
          totalCount: number | null;
          items: ListRow[];
          groups: CollectionGroupRow[] | null;
        }>(
          await nativeQuery(tx, queries, context, query, values, asOf, {
            search: searchPlan,
            customer,
            grouped,
            adaptiveOffset,
          }),
          values,
        );
  const { totalCount, items, groups } = result.rows[0]!;
  const rows = grouped ? items : items.slice(0, query.limit);
  const last = rows.at(-1);
  const grouping =
    grouped && groups
      ? groupResults(groups, maxGroups, true, (key, position) =>
          writeCursor(
            groupCursorContext(context.tenantId, query, key),
            position,
          ),
        )
      : undefined;
  const nextCursor = grouped
    ? null
    : query.adaptive
      ? items.length > query.limit
        ? writeAdaptiveCursor(scope, adaptiveOffset + query.limit)
        : null
      : items.length > query.limit && last
        ? writeCursor(scope, {
            rank: last.sortRank,
            keys: last.sortKeys ?? [last.sortKey ?? null],
            id: last.id,
          })
        : null;

  return {
    items: rows.map((row) => ({
      id: row.id,
      displayNumber: row.displayNumber,
      placedAt: iso(row.placedAt),
      total: money(row.total),
      status: row.status,
      paymentStatus: row.paymentStatus,
      fulfillment: row.fulfillment,
      lineCount: row.lineCount,
      open: row.open,
      overdue: row.overdue,
      dueAt: iso(row.dueAt),
      issueIds: row.issueIds,
      differs: row.differs,
      comparisonState: row.comparisonState,
      sources: row.sources.map(source),
      observedAt: iso(row.observedAt)!,
      sourceUpdatedAt: iso(row.sourceUpdatedAt),
      ...(row.tags === undefined
        ? {}
        : {
            channel: row.channel ?? null,
            tags: row.tags,
            test: row.test ?? null,
          }),
    })),
    totalCount,
    nextCursor,
    ...(grouping
      ? { groups: grouping.groups, groupsTruncated: grouping.truncated }
      : query.groupKey !== undefined
        ? {
            groups: [
              {
                key: query.groupKey,
                count: totalCount ?? 0,
                complete: true,
                itemIds: rows.map((row) => row.id),
                nextCursor,
                sums: [],
              },
            ],
          }
        : {}),
    asOf,
  };
}

/**
 * Compiles conditions, grouping and sorting into the native list query and appends the
 * compiled values to `values`. Reading one group always counts it exactly.
 */
async function nativeQuery(
  tx: SqlTransaction,
  queries: OrderReadQueries,
  context: TenantContext,
  query: OrderListQuery,
  values: unknown[],
  asOf: string,
  options: {
    search: false | 'selective' | 'broad';
    customer: number | undefined;
    grouped: boolean;
    adaptiveOffset: number;
  },
): Promise<string> {
  const timeZone = query.timeZone ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw collectionQueryError('Use an IANA time zone, such as Europe/Berlin.');
  }
  const adaptive = query.adaptive
    ? await adaptiveOrderSelection(
        tx,
        context,
        { ...query.adaptive, offset: options.adaptiveOffset },
        values,
      )
    : undefined;
  const compile: CollectionCompileContext = {
    parameters: new SqlParameters(values),
    now: new Date(asOf),
    timeZone,
    userId: context.actor.id,
  };
  const predicates: string[] = [];
  const requires = new Set<OrderFieldPart>();
  if (adaptive) predicates.push(adaptive.predicate);
  if (query.locationId || query.stockBlocked)
    predicates.push(
      openFulfillment(
        `${query.locationId ? `AND f.location_id=${compile.parameters.bind(query.locationId, 'uuid')}` : ''} ${query.stockBlocked ? freshStockHold : ''}`,
      ),
    );
  const customIds = customFieldIds([
    ...(query.where?.conditions.map((condition) => condition.field) ?? []),
    query.sort,
  ]);
  const custom = customIds.length
    ? await collectionCustomFields(
        tx,
        context,
        { type: 'order', id: 'o.entity_id' },
        customIds,
        compile.parameters,
        timeZone,
      )
    : undefined;
  if (query.where?.conditions.length) {
    const where = compileWhere(
      query.where,
      { ...orderCollectionFields(queries), ...custom?.fields },
      compile,
    );
    predicates.push(where.sql);
    for (const part of where.requires)
      if (part === 'needsYou' || part === 'hasIssue') requires.add(part);
  }
  const groupFields = orderGroupFields(queries);
  const groupField =
    query.group && Object.hasOwn(groupFields, query.group.field)
      ? groupFields[query.group.field]
      : undefined;
  if (query.group && !groupField)
    throw collectionQueryError('This field cannot be grouped');
  const request = groupField && {
    field: groupField,
    granularity: query.group?.granularity,
  };
  for (const part of groupField?.requires ?? []) requires.add(part);
  if (request && query.groupKey !== undefined)
    predicates.push(groupMemberPredicate(request, query.groupKey, compile));
  const ordering = {
    sort: isNativeSort(query.sort)
      ? orderSorts[query.sort]
      : customSort(custom?.sorts, query.sort),
    direction: query.direction,
    id: 'o.entity_id',
  };
  let page: OrderPageMode = { kind: 'keyset' };
  if (adaptive)
    page = {
      kind: 'adaptive',
      sort: adaptive.sort,
      offsetParameter: adaptive.offsetParameter,
    };
  else if (request && options.grouped)
    page = {
      kind: 'groups',
      ctes: groupCtes(
        'filtered',
        request,
        ordering,
        compile.parameters.bind(
          Math.min(Math.max(query.groupLimit ?? 10, 1), 50),
          'integer',
        ),
        maxGroups,
        {
          field: 'total',
          amount: 'o.total_amount',
          currency: 'o.total_currency',
        },
        compile,
      ),
      json: groupsJson,
      headIds: groupHeadIds,
    };

  return listSql(queries, {
    view: query.view,
    ordering,
    search: options.search,
    customerSearch: hasPermission(context, 'customers.read'),
    connection: !!query.connectionId,
    exactCount: query.count === 'exact' || query.groupKey !== undefined,
    customer: options.customer,
    predicates,
    requires,
    page,
  });
}

function isNativeSort(sort: string): sort is OrderSort {
  return Object.hasOwn(orderSorts, sort);
}
