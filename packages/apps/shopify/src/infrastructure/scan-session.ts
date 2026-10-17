import { createHash } from 'node:crypto';

import type {
  CapabilityInput,
  HistoryLimit,
  InvocationContext,
  Page,
} from '@luma/connections';
import {
  API_VERSION,
  createCursorCodec,
  fail,
  parse,
} from '@luma/connector-shopify';
import { z } from 'zod';

import type { ShopifyConnectorOptions } from './adapter.js';
import { readBulkHistory } from './bulk-history.js';
import { confirmDeletion } from './deletion-confirmation.js';
import { orderHistory } from './order-reads.js';
import { readPageSize, readSelection } from './read-selections.js';
import {
  createReadSession,
  next,
  pageFields,
  record,
  type ScanCapability,
  type ShopifyRequest,
} from './read-session.js';
import * as s from './schemas.js';

// Bound to the request that produced it; `after` is Shopify's opaque page cursor.
const readCursor = createCursorCodec(
  z.object({ binding: z.string(), after: z.string().min(1) }).strict(),
);

const counted = {
  'orders.read': 'ordersCount',
  'products.read': 'productsCount',
  'customers.read': 'customersCount',
} as const;

/** The records a scan page reads in full, with its next Shopify cursor. */
interface ScanRoots {
  roots: { id: string }[];
  nextAfter: string | null;
  total: number | null | undefined;
  history: HistoryLimit | null | undefined;
}

/**
 * Validates one scan call and prepares its page: checks the invocation targets this
 * connection, rejects invalid filter combinations and cursors bound to another request, then
 * reads the export chunk, collection size and history limit the page reports. A deletion
 * confirmation or a deferred export completes here and returns its `output` instead.
 */
export async function openReadSession(
  capability: ScanCapability,
  context: InvocationContext,
  input: CapabilityInput<ScanCapability>,
  {
    options,
    request,
    now,
    id,
  }: {
    options: ShopifyConnectorOptions;
    request: ShopifyRequest;
    now: () => Date;
    id: () => string;
  },
) {
  if (
    context.tenant.tenantId !== options.tenantId ||
    context.connectionId !== options.connectionId ||
    context.provider !== 'shopify'
  )
    fail('unavailable');
  // A point read of one order is not a scan; it cannot page or filter.
  if (
    capability === 'orders.read' &&
    'order' in input &&
    input.order &&
    (input.cursor ||
      input.updatedSince ||
      input.createdSince ||
      input.historyImport ||
      input.confirmMissing)
  )
    fail('invalid_input');
  if ('confirmMissing' in input && input.confirmMissing) {
    if (
      input.cursor ||
      input.updatedSince ||
      input.createdSince ||
      input.historyImport
    )
      fail('invalid_input');

    return {
      output: await confirmDeletion(capability, input.confirmMissing, {
        options,
        request,
        now,
        id,
      }),
    };
  }
  const filters = input as CapabilityInput<'inventory.read'> &
    CapabilityInput<'fulfillment.read'>;
  if (capability === 'inventory.read' && filters.includeComposition) {
    const access = parse(
      s.scanStart,
      await request(
        'query LumaScanStart { currentAppInstallation { accessScopes { handle } } }',
        {},
      ),
    );
    if (
      !access.currentAppInstallation.accessScopes.some((scope) =>
        ['read_products', 'write_products'].includes(scope.handle),
      )
    )
      fail('permission_denied');
  }
  const updatedSince =
    'updatedSince' in input ? (input.updatedSince ?? null) : null;
  const createdSince =
    'createdSince' in input ? (input.createdSince ?? null) : null;
  const historyImport =
    'historyImport' in input ? input.historyImport : undefined;
  const binding = createHash('sha256')
    .update(
      JSON.stringify([
        options.tenantId,
        options.connectionId,
        options.shop,
        API_VERSION,
        capability,
        // The effective page size, so cursors survive a larger requested page.
        readPageSize(capability, input.limit),
        filters.sku ?? null,
        filters.location ?? null,
        filters.includeComposition ?? false,
        filters.order ?? null,
        updatedSince,
        createdSince,
        historyImport?.key ?? null,
        historyImport?.chunkSize ?? null,
      ]),
    )
    .digest('hex');
  let after: string | null = null;
  if (input.cursor) {
    const cursor = readCursor.decode(input.cursor);
    if (cursor.binding !== binding) fail('invalid_input');
    after = cursor.after;
  }
  const session = createReadSession({ ...options, request, now, id });
  const orderCustomers = !!options.customerAccess && !!options.orderCustomers;
  const orderAddresses = !!options.customerAccess?.address;

  const root =
    capability === 'products.read'
      ? 'products'
      : capability === 'inventory.read'
        ? 'inventoryItems'
        : capability === 'customers.read'
          ? 'customers'
          : 'orders';
  const selected = filters.sku ?? filters.order;
  // Timestamps are validated ISO values, so quoting cannot add search operators.
  const search =
    [
      updatedSince ? `updated_at:>='${updatedSince}'` : null,
      createdSince ? `created_at:>='${createdSince}'` : null,
    ]
      .filter(Boolean)
      .join(' ') || null;
  const sorted = createdSince
    ? ', sortKey: CREATED_AT, reverse: true'
    : updatedSince
      ? ', sortKey: UPDATED_AT'
      : '';
  let total: number | null | undefined;
  let history: HistoryLimit | null | undefined;
  const bulk = historyImport
    ? await readBulkHistory({
        request,
        fetch: options.fetch ?? globalThis.fetch,
        capability,
        key: historyImport.key,
        cursor: after,
        limit: historyImport.chunkSize ?? input.limit,
        ...(options.customerAccess
          ? { customerAccess: options.customerAccess }
          : {}),
        orderCustomers,
      })
    : null;
  const encode = (cursor: string | null) =>
    cursor ? readCursor.encode({ binding, after: cursor }) : null;
  if (bulk?.deferred)
    return {
      output: parse<unknown>(s.outputs[capability], {
        items: [],
        nextCursor: encode(bulk.cursor),
        completeness: 'complete',
        deferred: true,
        retryAfterMs: 2000,
      }),
    };
  // Export records reflect the shop when the export started, not when Luma reads the file.
  if (bulk?.snapshotAt) session.observeAt(bulk.snapshotAt);

  // The first page of a scan reports the collection size and any history limit.
  if (
    (!after || bulk?.offset === 0) &&
    !selected &&
    capability !== 'inventory.read'
  ) {
    const countField =
      capability in counted
        ? counted[capability as keyof typeof counted]
        : null;
    const start = parse(
      s.scanStart,
      await request(
        countField
          ? `query LumaScanStart($query: String) { currentAppInstallation { accessScopes { handle } } count: ${countField}(query: $query, limit: null) { count precision } }`
          : 'query LumaScanStart { currentAppInstallation { accessScopes { handle } } }',
        countField ? { query: search } : {},
      ),
    );
    total = start.count?.count ?? null;
    if (root === 'orders')
      history = orderHistory(start.currentAppInstallation.accessScopes, now());
  }

  return {
    session: {
      ...session,
      capability,
      input,
      filters,
      options,
      request,
      now,
      orderCustomers,
      orderAddresses,
      root,
      selected,
      search,
      sorted,
      after,
      bulk,
      total,
      history,
      /** Builds the page result, binding Shopify's next cursor to this request. */
      page(scan: Omit<ScanRoots, 'roots'>): Page<unknown> {
        return {
          items: session.items,
          nextCursor: encode(scan.nextAfter),
          completeness: 'complete',
          retryAfterMs: request.nextReadDelay(),
          ...(scan.total === undefined ? {} : { total: scan.total }),
          ...(scan.history === undefined ? {} : { history: scan.history }),
        };
      },
    },
  };
}

/** One validated scan call: its read session plus the filters, cursor and page setup. */
export type ScanSession = Extract<
  Awaited<ReturnType<typeof openReadSession>>,
  { session: unknown }
>['session'];

/**
 * Lists the records on this page: the export chunk, the selected record, or one live page.
 * Records are cached so nested reads start from them.
 */
export async function readRoots(scan: ScanSession): Promise<ScanRoots> {
  const { bulk, selected, after, root, total, history } = scan;
  const rootType =
    root === 'products'
      ? 'Product'
      : root === 'inventoryItems'
        ? 'InventoryItem'
        : 'Order';
  if (bulk) {
    scan.remember(bulk.nodes);

    return {
      roots: bulk.nodes.map((value) => ({
        id: parse(s.gid(rootType), value.id),
      })),
      nextAfter: bulk.cursor,
      total: scan.capability === 'inventory.read' ? undefined : bulk.total,
      history,
    };
  }
  if (selected) {
    if (after) fail('invalid_input');

    return {
      roots: [{ id: selected.externalId }],
      nextAfter: null,
      total,
      history,
    };
  }
  const fields = readSelection(
    scan.capability,
    scan.orderCustomers,
    scan.orderAddresses,
    scan.filters.includeComposition === true,
  );
  const first = readPageSize(scan.capability, scan.input.limit);
  const data = await scan.request(
    root === 'inventoryItems'
      ? `query LumaPage($first: Int!, $after: String) { page: ${root}(first: $first, after: $after) { nodes { ${fields} } ${pageFields} } }`
      : `query LumaPage($first: Int!, $after: String, $query: String) { page: ${root}(first: $first, after: $after, query: $query${scan.sorted}) { nodes { ${fields} } ${pageFields} } }`,
    root === 'inventoryItems'
      ? { first, after }
      : { first, after, query: scan.search },
  );
  const page = parse(s.connection(record), data.page);
  scan.remember(page.nodes);
  const roots = page.nodes.map((value) => ({
    id: parse(s.gid(rootType), value.id),
  }));
  const nextAfter = next(page.pageInfo);
  if (nextAfter && nextAfter === after) fail('invalid_response');

  return {
    roots,
    nextAfter,
    total,
    history,
  };
}

/**
 * Reads the one order an `order` filter selects, with the same selection as an order page.
 * An absent order reports the history limit, since older orders can be hidden rather than gone.
 */
export async function readSelectedOrder(
  scan: ScanSession,
  selected: { externalId: string },
): Promise<ScanRoots> {
  const data = parse(
    z.object({ node: record.nullable() }),
    await scan.request(
      `query LumaOrder($id: ID!) { node(id: $id) { ... on Order { ${readSelection(scan.capability, scan.orderCustomers, scan.orderAddresses)} } } }`,
      { id: selected.externalId },
    ),
  );
  if (data.node) {
    if (parse(s.gid('Order'), data.node.id) !== selected.externalId)
      fail('invalid_response');
    scan.remember(data.node);

    return {
      roots: [{ id: selected.externalId }],
      nextAfter: null,
      total: scan.total,
      history: scan.history,
    };
  }
  const start = parse(
    s.scanStart,
    await scan.request(
      'query LumaScanStart { currentAppInstallation { accessScopes { handle } } }',
      {},
    ),
  );

  return {
    roots: [],
    nextAfter: null,
    total: scan.total,
    history: orderHistory(
      start.currentAppInstallation.accessScopes,
      scan.now(),
    ),
  };
}
