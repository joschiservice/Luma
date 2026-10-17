import type {
  ExternalId,
  MessageReadCapability,
  Observation,
  ReadCapability,
  SourceIdentity,
} from '@luma/connections';
import {
  type createClient,
  createPayloadCapture,
  fail,
  parse,
} from '@luma/connector-shopify';
import { z } from 'zod';

import type { ShopifyConnectorOptions } from './adapter.js';
import * as s from './schemas.js';

/** Read capabilities served by the shared Shopify scan handler. */
export type ScanCapability = Exclude<
  ReadCapability,
  | 'orders.shipping-method.read'
  | 'suppliers.read'
  | 'purchase-orders.read'
  | MessageReadCapability
  | 'returns.options.read'
  | 'returns.created.read'
  | 'returns.exchange.options.read'
  | 'returns.exchange.quote.read'
  | 'returns.exchange.proof.read'
  | 'returns.exchange.price.read'
  | 'returns.exchange.reservation.read'
  | 'returns.settlement.quote.read'
  | 'returns.settlement.proof.read'
  | 'inventory.transfers.read'
  | 'inventory.shipments.read'
>;

export type ShopifyRequest = ReturnType<typeof createClient>;

export const pageFields = 'pageInfo { hasNextPage endCursor }';

/** Builds a provider record reference, scoped when the ID is unique only within a parent. */
export const ref = (externalId: string, scopeKey = ''): ExternalId => ({
  externalId,
  scopeKey,
});

/** Expresses a Shopify unit count as a decimal quantity. */
export const quantity = (value: number) => ({
  amount: String(value),
  unit: 'each',
});

/** Blank or oversized source text is treated as not provided rather than truncated. */
export const text = (value: string | null | undefined, max = 512) => {
  const trimmed = value?.trim();

  return trimmed && trimmed.length <= max ? trimmed : null;
};

export const record = z.record(z.string(), z.unknown());

/** Maps a provider status to its canonical value; unlisted values are unknown. */
export const statusFrom = <T extends string>(
  mapping: Record<string, T>,
  value: string,
): T | 'unknown' =>
  Object.hasOwn(mapping, value) ? (mapping[value] ?? 'unknown') : 'unknown';

/** Returns the next page cursor, failing when Shopify reports more pages without one. */
export function next(page: z.infer<typeof s.pageInfo>): string | null {
  if (page.hasNextPage && !page.endCursor) fail('invalid_response');

  return page.hasNextPage ? page.endCursor : null;
}

/**
 * Creates the per-call state of one scan: emitted observations, the page cache that nested
 * reads start from, and captured payloads. Observations take the current observation time.
 */
export function createReadSession(
  options: Pick<
    ShopifyConnectorOptions,
    'tenantId' | 'connectionId' | 'rawRetentionMs'
  > & { request: ShopifyRequest; now: () => Date; id: () => string },
) {
  const { request, id } = options;
  // Parse before capture so unexpected fields, customer details and provider errors cannot enter evidence.
  const payloads = createPayloadCapture(options.rawRetentionMs, options.now);
  const capture = payloads.capture;
  let observedAt = options.now().toISOString();
  const items: Observation<unknown>[] = [];

  function emit(
    resource: SourceIdentity['resource'],
    external: ExternalId,
    updatedAt: string | null,
    data: unknown,
  ) {
    items.push({
      id: id(),
      source: {
        ...external,
        tenantId: options.tenantId,
        connectionId: options.connectionId,
        provider: 'shopify',
        resource,
      },
      kind: 'snapshot',
      observedAt,
      sourceUpdatedAt: updatedAt,
      sourceRevision: null,
      adapterVersion: s.adapterVersion,
      schemaVersion: 1,
      data,
    });
  }

  // Cache only this page. Consumers validate and allowlist each record before capture.
  const nested = new Map<string, Record<string, unknown>>();

  function remember(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) remember(item);
    } else if (value && typeof value === 'object') {
      const fields = parse(record, value);
      if (typeof fields.id === 'string')
        nested.set(fields.id, { ...nested.get(fields.id), ...fields });
      for (const child of Object.values(fields)) remember(child);
    }
  }

  async function node<T>(
    externalId: string,
    type: string,
    fields: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const cached = nested.get(externalId);
    // Overflow pages may cache an ID-only reference; fetch its full selection.
    if (cached && Object.keys(cached).length > 1)
      return capture(schema, cached);
    const data = await request(
      `query LumaNode($id: ID!) { node(id: $id) { ... on ${type} { ${fields} } } }`,
      { id: externalId },
    );
    if (data.node === null) fail('not_found');
    // Cached so protected fields can be read separately, without raw capture.
    remember(data.node);

    return capture(schema, data.node);
  }

  /**
   * Reads a nested connection completely, starting from the cached first page. `size`
   * bounds overflow pages so their requested cost stays under the query cost limit.
   */
  async function children<T>(
    externalId: string,
    type: string,
    field: string,
    fields: string,
    schema: z.ZodType<T>,
    { args = '', size = 100 }: { args?: string; size?: number } = {},
  ): Promise<T[]> {
    const result: T[] = [];
    let cursor: string | null = null;
    const initial = nested.get(externalId)?.[field];
    if (initial !== undefined) {
      const page = capture(s.connection(schema), initial);
      result.push(...page.nodes);
      cursor = next(page.pageInfo);
      if (!cursor) return result;
    }
    const seen = new Set<string>(cursor ? [cursor] : []);
    do {
      const data = await request(
        `query LumaChildren($id: ID!, $after: String) { node(id: $id) { ... on ${type} { children: ${field}(first: ${size}, after: $after${args ? `, ${args}` : ''}) { nodes { ${fields} } ${pageFields} } } } }`,
        { id: externalId, after: cursor },
      );
      if (data.node === null) fail('not_found');
      remember(data.node);
      const parent = parse(record, data.node);
      const page = capture(s.connection(schema), parent.children);
      result.push(...page.nodes);
      cursor = next(page.pageInfo);
      if (cursor && seen.has(cursor)) fail('invalid_response');
      if (cursor) seen.add(cursor);
      // Bound malformed or unexpectedly large scans; never return a truncated snapshot.
      if (seen.size > 1000) fail('invalid_response');
    } while (cursor);

    return result;
  }

  return {
    items,
    capture,
    raw: payloads.raw,
    emit,
    remember,
    node,
    children,
    /** The cached fields of a record read on this page, if any. */
    cached: (externalId: string) => nested.get(externalId),
    /** Sets the observation time for records emitted afterwards. */
    observeAt(value: string) {
      observedAt = value;
    },
  };
}

export type ReadSession = ReturnType<typeof createReadSession>;
