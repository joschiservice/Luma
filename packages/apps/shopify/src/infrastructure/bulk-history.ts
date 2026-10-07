import { createHash } from 'node:crypto';

import type { ReadCapability } from '@luma/connections';
import { fail, parse } from '@luma/connector-shopify';
import { z } from 'zod';

import { bulkReadSelection } from './read-selections.js';

const operation = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/BulkOperation\/\d+$/),
  status: z.enum([
    'CREATED',
    'RUNNING',
    'COMPLETED',
    'FAILED',
    'CANCELED',
    'CANCELING',
    'EXPIRED',
  ]),
  query: z.string(),
  url: z.string().nullable(),
  rootObjectCount: z.string().regex(/^\d+$/),
  createdAt: z.string().datetime({ offset: true }),
});
const fields = 'id status query url rootObjectCount createdAt';
const childField: Record<string, string> = {
  LineItem: 'lineItems',
  ProductVariant: 'variants',
  InventoryLevel: 'inventoryLevels',
};
const emptyConnection = () => ({
  nodes: [] as Record<string, unknown>[],
  pageInfo: { hasNextPage: false, endCursor: null },
});

export interface BulkHistoryPage {
  nodes: Record<string, unknown>[];
  cursor: string | null;
  deferred: boolean;
  offset: number;
  total: number;
  /** When Shopify started the export; its records may be no newer than this. */
  snapshotAt: string | null;
}

/**
 * Resumes an export by its stable query identity and imports a bounded, grouped JSONL chunk.
 * A lost start response is recovered by listing the matching operation. Files stay in memory
 * only for the current chunk; incomplete and expired operations never establish coverage.
 */
export async function readBulkHistory(options: {
  request(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  fetch: typeof globalThis.fetch;
  capability: ReadCapability;
  key: string;
  cursor: string | null;
  limit: number;
  customerAccess?: { contact: boolean; address: boolean };
}): Promise<BulkHistoryPage> {
  const root =
    options.capability === 'products.read'
      ? 'products'
      : options.capability === 'inventory.read'
        ? 'inventoryItems'
        : options.capability === 'customers.read'
          ? 'customers'
          : 'orders';
  const alias = `luma_${createHash('sha256').update(options.key).digest('hex').slice(0, 24)}`;
  const query = `{ ${alias}: ${root} { edges { node { ${bulkReadSelection(options.capability, options.customerAccess)} } } } }`;
  let offset = 0;
  let rootsSeen = 0;
  let current: z.infer<typeof operation> | undefined;
  if (options.cursor) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(options.cursor);
    } catch {
      fail('invalid_input');
    }
    const checkpoint = parse(
      z
        .object({
          id: operation.shape.id,
          offset: z.number().int().nonnegative(),
          roots: z.number().int().nonnegative(),
        })
        .strict(),
      decoded,
    );
    offset = checkpoint.offset;
    rootsSeen = checkpoint.roots;
    const data = await options.request(
      `query LumaBulkStatus($id: ID!) { bulkOperation(id: $id) { ${fields} } }`,
      { id: checkpoint.id },
    );
    current = parse(operation, data.bulkOperation);
    if (current.query !== query) fail('invalid_input');
  } else {
    // Shopify has five query slots on 2026-07. Reuse our export after an uncertain start.
    let after: string | null = null;
    let active = 0;
    for (let page = 0; page < 100; page++) {
      const data = await options.request(
        `query LumaBulkList($after: String) { bulkOperations(first: 100, after: $after) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`,
        { after },
      );
      const found = parse(
        z.object({
          nodes: z.array(operation),
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
        }),
        data.bulkOperations,
      );
      current = found.nodes.find((item) => item.query === query);
      active += found.nodes.filter((item) =>
        ['CREATED', 'RUNNING', 'CANCELING'].includes(item.status),
      ).length;
      if (current || !found.pageInfo.hasNextPage) break;
      if (!found.pageInfo.endCursor || found.pageInfo.endCursor === after)
        fail('invalid_response');
      after = found.pageInfo.endCursor;
      if (page === 99) fail('invalid_response');
    }
    if (!current) {
      if (active >= 5)
        return {
          nodes: [],
          cursor: null,
          deferred: true,
          offset,
          total: 0,
          snapshotAt: null,
        };
      const data = await options.request(
        `mutation LumaBulkStart($query: String!) { bulkOperationRunQuery(query: $query, groupObjects: true) { bulkOperation { ${fields} } userErrors { field message } } }`,
        { query },
      );
      const started = parse(
        z.object({
          bulkOperation: operation.nullable(),
          userErrors: z.array(
            z.object({
              field: z.array(z.string()).nullable(),
              message: z.string(),
            }),
          ),
        }),
        data.bulkOperationRunQuery,
      );
      if (started.userErrors.length || !started.bulkOperation)
        fail('invalid_response');
      current = started.bulkOperation;
    }
  }
  const cursor = (position: number) =>
    JSON.stringify({ id: current.id, offset: position, roots: rootsSeen });
  const total = Number(current.rootObjectCount);
  if (!Number.isSafeInteger(total)) fail('invalid_response');
  if (['CREATED', 'RUNNING', 'CANCELING'].includes(current.status))
    return {
      nodes: [],
      cursor: cursor(offset),
      deferred: true,
      offset,
      total,
      snapshotAt: null,
    };
  if (current.status !== 'COMPLETED') fail('export_unavailable');
  if (!current.url) {
    if (total !== 0) fail('invalid_response');

    return {
      nodes: [],
      cursor: null,
      deferred: false,
      offset,
      total,
      snapshotAt: null,
    };
  }
  const url = new URL(current.url);
  // Shopify serves signed exports from Google Cloud Storage. Never send shop credentials.
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'storage.googleapis.com' ||
    url.username ||
    url.password
  )
    fail('invalid_response');
  const response = await options.fetch(url, {
    headers: offset ? { Range: `bytes=${offset}-` } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if ([403, 404, 410].includes(response.status)) fail('export_unavailable');
  if (![200, 206].includes(response.status) || !response.body)
    fail('transient', 2000);
  if (
    response.status === 206 &&
    !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)
  )
    fail('invalid_response');
  const reader = response.body.getReader();
  const nodes: Record<string, unknown>[] = [];
  let bytes = new Uint8Array(0);
  let position = response.status === 206 ? offset : 0;
  let rootNode: Record<string, unknown> | null = null;
  let nextOffset: number | null = null;
  let childCount = 0;
  const decode = new TextDecoder('utf-8', { fatal: true });

  function line(value: Uint8Array) {
    if (value.byteLength > 16 * 1024 * 1024) fail('invalid_response');
    const start = position;
    position += value.byteLength + 1;
    if (start < offset) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(decode.decode(value));
    } catch {
      fail('invalid_response');
    }
    const item = parse(z.record(z.unknown()), decoded);
    const parent = item.__parentId;
    delete item.__parentId;
    if (parent === undefined) {
      if (nodes.length >= options.limit) {
        nextOffset = start;

        return;
      }
      if (typeof item.id !== 'string') fail('invalid_response');
      rootNode = item;
      childCount = 0;
      const child =
        root === 'orders'
          ? 'lineItems'
          : root === 'products'
            ? 'variants'
            : root === 'inventoryItems'
              ? 'inventoryLevels'
              : null;
      if (child) rootNode[child] = emptyConnection();
      nodes.push(rootNode);
    } else {
      if (
        !rootNode ||
        parent !== rootNode.id ||
        typeof item.id !== 'string' ||
        ++childCount > 100_000
      )
        fail('invalid_response');
      const type = /^gid:\/\/shopify\/([^/]+)\//.exec(item.id)?.[1];
      const field = type && childField[type];
      const connection = field && rootNode[field];
      if (
        !connection ||
        typeof connection !== 'object' ||
        !('nodes' in connection) ||
        !Array.isArray(connection.nodes)
      )
        fail('invalid_response');
      connection.nodes.push(item);
    }
  }

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (bytes.length) {
          line(bytes);
          position--;
        }
        break;
      }
      const joined = new Uint8Array(bytes.length + chunk.value.length);
      joined.set(bytes);
      joined.set(chunk.value, bytes.length);
      let start = 0;
      for (let i = 0; i < joined.length; i++)
        if (joined[i] === 10) {
          if (i > start) line(joined.subarray(start, i));
          else position++;
          start = i + 1;
          if (nextOffset !== null) break;
        }
      if (nextOffset !== null) break;
      bytes = joined.slice(start);
      if (bytes.length > 16 * 1024 * 1024) fail('invalid_response');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  rootsSeen += nodes.length;
  if (nextOffset === null && rootsSeen !== total) fail('invalid_response');

  return {
    nodes,
    cursor: nextOffset === null ? null : cursor(nextOffset),
    deferred: false,
    offset,
    total,
    snapshotAt: new Date(current.createdAt).toISOString(),
  };
}
