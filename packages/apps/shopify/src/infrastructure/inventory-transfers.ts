import { createHash } from 'node:crypto';

import type {
  CapabilityHandler,
  InventoryShipmentSnapshot,
  InventoryTransferSnapshot,
  Observation,
  Page,
} from '@luma/connections';
import {
  shipmentSnapshotSchema,
  transferSnapshotSchema,
} from '@luma/connections/composition';
import {
  API_VERSION,
  createClient,
  fail,
  parse,
} from '@luma/connector-shopify';
import { z } from 'zod';

import type { ShopifyConnectorOptions } from './adapter.js';
import { adapterVersion } from './schemas.js';

const gid = (kind: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${kind}/[0-9]+$`));
const ref = (externalId: string) => ({ externalId, scopeKey: '' });
const timestamp = z.string().datetime();
const count = z.number().int().nonnegative();
const pageInfo = 'pageInfo { hasNextPage endCursor }';
const infoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const inputSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: z.string().max(8192).optional(),
    confirmMissing: z
      .object({
        externalId: z.string(),
        scopeKey: z.literal(''),
        createdAt: timestamp.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
const cursorSchema = z
  .object({ context: z.string(), after: z.string().max(4096) })
  .strict();
const lineTransfer =
  'id title totalQuantity pickedForShipmentQuantity shippableQuantity shippedQuantity';
const lineShipment =
  'id quantity acceptedQuantity rejectedQuantity unreceivedQuantity';
const transferBase =
  'id name status dateCreated totalQuantity receivedQuantity';
const shipmentBase =
  'id name status dateCreated dateShipped dateReceived lineItemTotalQuantity totalAcceptedQuantity totalRejectedQuantity totalReceivedQuantity tracking { arrivesAt company trackingNumber trackingUrl }';
const address =
  'address { address1 address2 city provinceCode countryCode zip }';
const text = (value: string | null) =>
  value?.trim() && value.trim().length <= 512 ? value.trim() : null;
const link = (value: string | null) =>
  value && value.length <= 2048 && /^https?:\/\//i.test(value) ? value : null;

const locationSchema = z
  .object({
    name: z.string(),
    snapshottedAt: timestamp,
    location: z
      .object({ id: gid('Location') })
      .nullable()
      .optional(),
    address: z.object({
      address1: z.string().nullable(),
      address2: z.string().nullable(),
      city: z.string().nullable(),
      provinceCode: z.string().nullable(),
      countryCode: z.string().nullable(),
      zip: z.string().nullable(),
    }),
  })
  .nullable();
const transferSchema = z.object({
  id: gid('InventoryTransfer'),
  name: z.string(),
  status: z.string(),
  dateCreated: timestamp.nullable(),
  totalQuantity: count,
  receivedQuantity: count,
  origin: locationSchema,
  destination: locationSchema,
});
const shipmentSchema = z.object({
  id: gid('InventoryShipment'),
  name: z.string(),
  status: z.string(),
  dateCreated: timestamp.nullable(),
  dateShipped: timestamp.nullable(),
  dateReceived: timestamp.nullable(),
  lineItemTotalQuantity: count,
  totalAcceptedQuantity: count,
  totalRejectedQuantity: count,
  totalReceivedQuantity: count,
  tracking: z
    .object({
      arrivesAt: timestamp.nullable(),
      company: z.string().nullable(),
      trackingNumber: z.string().nullable(),
      trackingUrl: z.string().nullable(),
    })
    .nullable(),
});
const item = z
  .object({ id: gid('InventoryItem') })
  .nullable()
  .optional();
const transferLineSchema = z.object({
  id: gid('InventoryTransferLineItem'),
  inventoryItem: item,
  title: z.string().nullable(),
  totalQuantity: count,
  pickedForShipmentQuantity: count,
  shippableQuantity: count,
  shippedQuantity: count,
});
const shipmentLineSchema = z.object({
  id: gid('InventoryShipmentLineItem'),
  inventoryItem: item,
  quantity: count,
  acceptedQuantity: count,
  rejectedQuantity: count,
  unreceivedQuantity: count,
});

function parsePage<T>(
  data: z.ZodType<T>,
  resource: 'inventory_transfer' | 'inventory_shipment',
  value: unknown,
): Page<T> {
  const result = parse(
    z.object({
      items: z.array(
        z.object({
          id: z.string().uuid(),
          source: z.object({
            tenantId: z.string().min(1),
            connectionId: z.string().min(1),
            provider: z.literal('shopify'),
            resource: z.literal(resource),
            externalId: z.string().min(1),
            scopeKey: z.string(),
          }),
          kind: z.enum(['snapshot', 'tombstone']),
          observedAt: timestamp,
          sourceUpdatedAt: timestamp.nullable(),
          sourceRevision: z.string().nullable(),
          adapterVersion: z.literal(adapterVersion),
          schemaVersion: z.literal(1),
          data,
        }),
      ),
      nextCursor: z.string().nullable(),
      completeness: z.enum(['complete', 'partial']),
      retryAfterMs: z.number().nonnegative().optional(),
      confirmation: z.enum(['present', 'deleted']).optional(),
    }),
    value,
  );

  return {
    items: result.items,
    nextCursor: result.nextCursor,
    completeness: result.completeness,
    ...(result.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: result.retryAfterMs }),
    ...(result.confirmation === undefined
      ? {}
      : { confirmation: result.confirmation }),
  };
}

/** Reads bounded complete transfer and receiving collections; no quantity is written or added to a position. */
export function createInventoryTransferCapabilities(
  options: ShopifyConnectorOptions & {
    now: () => Date;
    id: () => string;
    shipmentAccess?: boolean;
  },
) {
  const request = createClient(options);
  const descriptor: CapabilityHandler<'inventory.transfers.read'>['descriptor'] =
    {
      version: '0',
      minimumRisk: 'low',
      idempotency: 'none',
      retry: { maxAttempts: 3, initialDelayMs: 1000 },
      filters: ['confirmMissing'],
    };

  async function collection<T>(
    id: string,
    kind: string,
    field: string,
    selection: string,
    schema: z.ZodType<T>,
  ): Promise<T[] | null> {
    const rows: T[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    do {
      const raw: Record<string, unknown> = await request(
        `query LumaInventoryTransferChildren($id: ID!, $after: String) {
        node: ${kind === 'InventoryTransfer' ? 'inventoryTransfer' : 'inventoryShipment'}(id: $id) { children: ${field}(first: 50, after: $after) { nodes { ${selection} } ${pageInfo} } }
      }`,
        { id, after },
      );
      const node: {
        children: { nodes: T[]; pageInfo: z.infer<typeof infoSchema> } | null;
      } | null = parse(
        z
          .object({
            children: z
              .object({ nodes: z.array(schema), pageInfo: infoSchema })
              .nullable(),
          })
          .nullable(),
        raw.node,
      );
      if (!node?.children) return null;
      rows.push(...node.children.nodes);
      const page: z.infer<typeof infoSchema> = node.children.pageInfo;
      if (!page.hasNextPage) break;
      if (!page.endCursor || seen.has(page.endCursor) || rows.length >= 5000)
        fail('invalid_response');
      seen.add(page.endCursor);
      after = page.endCursor;
    } while (after !== null);
    if (rows.length > 5000) fail('invalid_response');

    return rows;
  }

  async function read<
    K extends 'inventory.transfers.read' | 'inventory.shipments.read',
  >(capability: K, input: z.infer<typeof inputSchema>) {
    const observedAt = options.now().toISOString();
    const access = parse(
      z.object({
        currentAppInstallation: z.object({
          accessScopes: z.array(z.object({ handle: z.string() })),
        }),
      }),
      await request(
        'query LumaInventoryTransferAccess { currentAppInstallation { accessScopes { handle } } }',
        {},
      ),
    );
    const scopes = new Set(
      access.currentAppInstallation.accessScopes.map((s) => s.handle),
    );
    const has = (scope: string) =>
      scopes.has(`read_${scope}`) || scopes.has(`write_${scope}`);
    const itemAccess = has('inventory') || has('products');
    const locationAccess = has('locations') || has('inventory');
    const ships =
      capability === 'inventory.transfers.read' &&
      options.shipmentAccess === true &&
      has('inventory_shipments');
    const context = createHash('sha256')
      .update(
        JSON.stringify([
          adapterVersion,
          options.tenantId,
          options.connectionId,
          capability,
          itemAccess,
          locationAccess,
          ships,
        ]),
      )
      .digest('hex');
    let after: string | null = null;
    if (input.cursor) {
      try {
        const bytes = Buffer.from(input.cursor, 'base64url');
        if (bytes.toString('base64url') !== input.cursor) fail('invalid_input');
        const decoded = cursorSchema.parse(JSON.parse(bytes.toString()));
        if (decoded.context !== context) fail('invalid_input');
        after = decoded.after;
      } catch {
        fail('invalid_input');
      }
    }
    const transfer = capability === 'inventory.transfers.read';
    const kind = transfer ? 'InventoryTransfer' : 'InventoryShipment';
    const singular = transfer ? 'inventoryTransfer' : 'inventoryShipment';
    const plural = transfer ? 'inventoryTransfers' : 'inventoryShipments';
    const locations = `origin { name snapshottedAt ${address} ${locationAccess ? 'location { id }' : ''} } destination { name snapshottedAt ${address} ${locationAccess ? 'location { id }' : ''} }`;
    const selection = transfer ? `${transferBase} ${locations}` : shipmentBase;
    const root = input.confirmMissing
      ? await request(
          `query LumaInventoryTransferRecord($id: ID!) { record: ${singular}(id: $id) { ${selection} } }`,
          { id: gid(kind).parse(input.confirmMissing.externalId) },
        )
      : await request(
          `query LumaInventoryTransferPage($first: Int!, $after: String) { page: ${plural}(first: $first, after: $after) { nodes { ${selection} } ${pageInfo} } }`,
          { first: Math.min(input.limit, 5), after },
        );
    const page = input.confirmMissing
      ? {
          nodes: root.record === null ? [] : [root.record],
          pageInfo: { hasNextPage: false, endCursor: null },
        }
      : parse(
          z.object({ nodes: z.array(z.unknown()), pageInfo: infoSchema }),
          root.page,
        );
    const observations: Observation<
      InventoryTransferSnapshot | InventoryShipmentSnapshot
    >[] = [];
    const emit = (
      externalId: string,
      data: InventoryTransferSnapshot | InventoryShipmentSnapshot,
      deleted = false,
    ) =>
      observations.push({
        id: options.id(),
        source: {
          tenantId: options.tenantId,
          connectionId: options.connectionId,
          provider: 'shopify',
          resource: transfer ? 'inventory_transfer' : 'inventory_shipment',
          ...ref(externalId),
        },
        kind: deleted ? 'tombstone' : 'snapshot',
        observedAt,
        sourceUpdatedAt: null,
        sourceRevision: deleted
          ? null
          : createHash('sha256').update(JSON.stringify(data)).digest('hex'),
        adapterVersion,
        schemaVersion: 1,
        data,
      });
    for (const raw of page.nodes) {
      if (transfer) {
        const record = parse(transferSchema, raw);
        const lines = await collection(
          record.id,
          kind,
          'lineItems',
          `${lineTransfer} ${itemAccess ? 'inventoryItem { id }' : ''}`,
          transferLineSchema,
        );
        const shipments = ships
          ? await collection(
              record.id,
              kind,
              'shipments',
              'id',
              z.object({ id: gid('InventoryShipment') }),
            )
          : null;
        const mappedLocation = (value: z.infer<typeof locationSchema>) =>
          value
            ? {
                id: value.location ? ref(value.location.id) : null,
                name: value.name,
                snapshottedAt: value.snapshottedAt,
                address: {
                  address1: text(value.address.address1),
                  address2: text(value.address.address2),
                  city: text(value.address.city),
                  provinceCode: text(value.address.provinceCode),
                  countryCode: text(value.address.countryCode),
                  zip: text(value.address.zip),
                },
              }
            : null;
        const states: Record<string, InventoryTransferSnapshot['status']> = {
          DRAFT: 'draft',
          READY_TO_SHIP: 'ready',
          IN_PROGRESS: 'in_progress',
          TRANSFERRED: 'received',
          CANCELED: 'cancelled',
        };
        emit(
          record.id,
          parse<InventoryTransferSnapshot>(transferSnapshotSchema, {
            name: record.name,
            status: states[record.status] ?? 'unknown',
            createdAt: record.dateCreated,
            origin: mappedLocation(record.origin),
            destination: mappedLocation(record.destination),
            requestedQuantity: String(record.totalQuantity),
            receivedQuantity: String(record.receivedQuantity),
            lines:
              lines?.map((line) => ({
                id: ref(line.id),
                sku: line.inventoryItem ? ref(line.inventoryItem.id) : null,
                title: text(line.title),
                unit: 'each',
                requested: String(line.totalQuantity),
                picked: String(line.pickedForShipmentQuantity),
                ready: String(line.shippableQuantity),
                shipped: String(line.shippedQuantity),
              })) ?? null,
            shipments: shipments?.map((shipment) => ref(shipment.id)) ?? null,
          }),
        );
      } else {
        const record = parse(shipmentSchema, raw);
        const lines = await collection(
          record.id,
          kind,
          'lineItems',
          `${lineShipment} ${itemAccess ? 'inventoryItem { id }' : ''}`,
          shipmentLineSchema,
        );
        const states: Record<string, InventoryShipmentSnapshot['status']> = {
          DRAFT: 'draft',
          IN_TRANSIT: 'in_transit',
          PARTIALLY_RECEIVED: 'partially_received',
          RECEIVED: 'received',
        };
        emit(
          record.id,
          parse<InventoryShipmentSnapshot>(shipmentSnapshotSchema, {
            name: record.name,
            status: states[record.status] ?? 'unknown',
            createdAt: record.dateCreated,
            shippedAt: record.dateShipped,
            receivedAt: record.dateReceived,
            expectedArrivalAt: record.tracking?.arrivesAt ?? null,
            quantity: String(record.lineItemTotalQuantity),
            receivedQuantity: String(record.totalReceivedQuantity),
            acceptedQuantity: String(record.totalAcceptedQuantity),
            rejectedQuantity: String(record.totalRejectedQuantity),
            lines:
              lines?.map((line) => ({
                id: ref(line.id),
                sku: line.inventoryItem ? ref(line.inventoryItem.id) : null,
                unit: 'each',
                quantity: String(line.quantity),
                accepted: String(line.acceptedQuantity),
                rejected: String(line.rejectedQuantity),
                unreceived: String(line.unreceivedQuantity),
              })) ?? null,
            tracking: record.tracking
              ? {
                  carrier: text(record.tracking.company),
                  number: text(record.tracking.trackingNumber),
                  url: link(record.tracking.trackingUrl),
                }
              : null,
          }),
        );
      }
    }
    if (input.confirmMissing && !page.nodes.length)
      emit(
        input.confirmMissing.externalId,
        transfer
          ? {
              name: input.confirmMissing.externalId,
              status: 'unknown',
              createdAt: null,
              origin: null,
              destination: null,
              requestedQuantity: '0',
              receivedQuantity: '0',
              lines: null,
              shipments: null,
            }
          : {
              name: input.confirmMissing.externalId,
              status: 'unknown',
              createdAt: null,
              shippedAt: null,
              receivedAt: null,
              expectedArrivalAt: null,
              quantity: '0',
              receivedQuantity: '0',
              acceptedQuantity: '0',
              rejectedQuantity: '0',
              lines: null,
              tracking: null,
            },
        true,
      );
    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
      fail('invalid_response');
    await options.recordObservations({
      tenantId: options.tenantId,
      connectionId: options.connectionId,
      apiVersion: API_VERSION,
      capability,
      observations,
    });

    return {
      items: observations,
      nextCursor: page.pageInfo.hasNextPage
        ? Buffer.from(
            JSON.stringify({ context, after: page.pageInfo.endCursor }),
          ).toString('base64url')
        : null,
      completeness: 'complete' as const,
      retryAfterMs: request.nextReadDelay(),
      ...(input.confirmMissing
        ? {
            confirmation: page.nodes.length
              ? ('present' as const)
              : ('deleted' as const),
          }
        : {}),
    };
  }

  const parseInput = (value: unknown, kind: string) => {
    const input = inputSchema.parse(value);
    if (input.confirmMissing) gid(kind).parse(input.confirmMissing.externalId);

    return {
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.confirmMissing ? { confirmMissing: input.confirmMissing } : {}),
    };
  };
  const transferHandler: CapabilityHandler<'inventory.transfers.read'> = {
    descriptor,
    parseInput: (value) => parseInput(value, 'InventoryTransfer'),
    parseOutput: (value) =>
      parsePage(transferSnapshotSchema, 'inventory_transfer', value),
    run: async (context, input) => {
      if (
        context.tenant.tenantId !== options.tenantId ||
        context.connectionId !== options.connectionId ||
        context.provider !== 'shopify'
      )
        fail('permission_denied');

      return parsePage(
        transferSnapshotSchema,
        'inventory_transfer',
        await read(
          'inventory.transfers.read',
          parseInput(input, 'InventoryTransfer'),
        ),
      );
    },
  };
  const shipmentHandler: CapabilityHandler<'inventory.shipments.read'> = {
    descriptor,
    parseInput: (value) => parseInput(value, 'InventoryShipment'),
    parseOutput: (value) =>
      parsePage(shipmentSnapshotSchema, 'inventory_shipment', value),
    run: async (context, input) => {
      if (
        context.tenant.tenantId !== options.tenantId ||
        context.connectionId !== options.connectionId ||
        context.provider !== 'shopify'
      )
        fail('permission_denied');

      return parsePage(
        shipmentSnapshotSchema,
        'inventory_shipment',
        await read(
          'inventory.shipments.read',
          parseInput(input, 'InventoryShipment'),
        ),
      );
    },
  };

  return {
    'inventory.transfers.read': transferHandler,
    'inventory.shipments.read': shipmentHandler,
  };
}
