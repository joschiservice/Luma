import type { ExternalId, Observation } from '@luma/connections';
import { API_VERSION, fail, parse } from '@luma/connector-shopify';
import { z } from 'zod';

import type { ShopifyConnectorOptions } from './adapter.js';
import { recentOrderWindowMs } from './order-reads.js';
import {
  ref,
  type ScanCapability,
  type ShopifyRequest,
} from './read-session.js';
import * as s from './schemas.js';

/**
 * Confirms whether a record missing from scans is gone from Shopify. A confirmed deletion
 * records and returns a tombstone; a present record or an order outside the readable history
 * window returns no items and its confirmation state.
 */
export async function confirmDeletion(
  capability: ScanCapability,
  candidate: ExternalId & { createdAt: string | null },
  {
    options,
    request,
    now,
    id,
  }: {
    options: Pick<
      ShopifyConnectorOptions,
      'tenantId' | 'connectionId' | 'recordObservations'
    >;
    request: ShopifyRequest;
    now: () => Date;
    id: () => string;
  },
): Promise<unknown> {
  const observedAt = now().toISOString();
  const access = parse(
    s.scanStart,
    await request(
      'query LumaDeletionAccess { currentAppInstallation { accessScopes { handle } } }',
      {},
    ),
  );
  const scopes = access.currentAppInstallation.accessScopes.map(
    (scope) => scope.handle,
  );
  const has = (scope: string) =>
    scopes.includes(scope) || scopes.includes(scope.replace('read_', 'write_'));
  const required =
    capability === 'orders.read'
      ? 'read_orders'
      : capability === 'products.read'
        ? 'read_products'
        : 'read_inventory';
  if (!has(required)) fail('permission_denied');
  if (
    capability === 'orders.read' &&
    !has('read_all_orders') &&
    (!candidate.createdAt ||
      Date.parse(candidate.createdAt) <= +now() - recentOrderWindowMs)
  )
    return {
      items: [],
      nextCursor: null,
      completeness: 'complete',
      confirmation: 'history_limited',
    };
  const type =
    capability === 'orders.read'
      ? 'Order'
      : capability === 'products.read'
        ? 'Product'
        : 'InventoryItem';
  const data = parse(
    z.object({ node: z.object({ id: s.gid(type) }).nullable() }),
    await request(
      `query LumaDeletionNode($id: ID!) { node(id: $id) { ... on ${type} { id } } }`,
      { id: candidate.externalId },
    ),
  );
  let absent = data.node === null;
  if (capability === 'inventory.read' && data.node) {
    const level = parse(
      z.object({
        node: z.object({
          inventoryLevel: z.object({ id: s.gid('InventoryLevel') }).nullable(),
        }),
      }),
      await request(
        'query LumaDeletionLevel($id: ID!, $location: ID!) { node(id: $id) { ... on InventoryItem { inventoryLevel(locationId: $location) { id } } } }',
        { id: candidate.externalId, location: candidate.scopeKey },
      ),
    );
    absent = level.node.inventoryLevel === null;
  }
  if (!absent)
    return {
      items: [],
      nextCursor: null,
      completeness: 'complete',
      confirmation: 'present',
    };
  const tombstone: Observation<unknown> = {
    id: id(),
    source: {
      tenantId: options.tenantId,
      connectionId: options.connectionId,
      provider: 'shopify',
      resource:
        capability === 'orders.read'
          ? 'order'
          : capability === 'products.read'
            ? 'product'
            : 'sku',
      externalId: candidate.externalId,
      scopeKey: candidate.scopeKey,
    },
    kind: 'tombstone',
    observedAt,
    sourceUpdatedAt: null,
    sourceRevision: null,
    adapterVersion: s.adapterVersion,
    schemaVersion: 1,
    data:
      capability === 'orders.read'
        ? {
            displayNumber: null,
            placedAt: null,
            total: null,
            status: 'unknown',
            paymentStatus: 'unknown',
            lines: [],
          }
        : capability === 'products.read'
          ? {
              title: null,
              status: 'unknown',
              vendor: null,
              published: false,
              skus: [],
            }
          : {
              sku: ref(candidate.externalId),
              location: ref(candidate.scopeKey),
              unit: 'each',
              onHand: null,
              reserved: null,
              available: null,
              availabilityBasis: 'unknown',
            },
  };
  const result = parse<unknown>(s.outputs[capability], {
    items: [tombstone],
    nextCursor: null,
    completeness: 'complete',
    confirmation: 'deleted',
  });
  await options.recordObservations({
    tenantId: options.tenantId,
    connectionId: options.connectionId,
    apiVersion: API_VERSION,
    capability,
    observations: [tombstone],
  });

  return result;
}
