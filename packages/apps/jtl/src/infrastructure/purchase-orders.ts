import { createHash, randomUUID } from 'node:crypto';

import {
  type CapabilityHandler,
  type CapabilityInput,
  type CapabilityOutput,
  type ConnectorConnection,
  ConnectorError,
  type ConnectorFailure,
  type ExternalId,
  type InvocationContext,
  type Observation,
  type SupplierOrderSnapshot,
  type SupplierOrderStatus,
  type SupplierSnapshot,
} from '@luma/connections';
import {
  API_VERSION,
  createClient,
  createPayloadCapture,
  fail,
  parse,
} from '@luma/connector-jtl';
import { z } from 'zod';

import { jtlPermissions } from '../domain/permissions.js';
import type { JtlConnectorOptions } from './adapter.js';
import { adapterVersion, outputs, pageCursor } from './outputs.js';
import { createJtlPurchaseOrderRevision } from './purchase-order-revisions.js';
import * as s from './schemas.js';

/** Derives a version-5-shaped UUID from the given parts; equal parts give equal IDs. */
export function stableUuid(parts: readonly string[]) {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Names the accepted creation of one JTL purchase order as a stable UUID, because execution
 * evidence references are UUIDs. The JTL order itself is found again by an independent read.
 */
export function acceptanceId(
  tenantId: string,
  connectionId: string,
  purchaseOrderId: string,
) {
  return stableUuid([
    'jtl',
    'purchase-order',
    tenantId,
    connectionId,
    purchaseOrderId,
  ]);
}

type PurchaseOrder = z.infer<typeof s.purchaseOrder>;

type ReadKind = 'suppliers.read' | 'purchase-orders.read';

const ref = (id: string, scopeKey = ''): ExternalId => ({
  externalId: id,
  scopeKey,
});

const text = (value: string | null | undefined) => {
  const trimmed = value?.trim();

  return trimmed && trimmed.length <= 512 ? trimmed : null;
};

const email = (value: string | null | undefined) => {
  const trimmed = value?.trim();

  return trimmed && trimmed.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(trimmed)
    ? trimmed
    : null;
};

const statuses: Record<number, SupplierOrderStatus> = {
  0: 'open',
  5: 'released',
  20: 'in_progress',
  30: 'partially_delivered',
  50: 'overdue',
  500: 'completed',
};

// JTL `lineItemType` 1 is an item position; free positions name no stocked item.
const ITEM_LINE = 1;

/** Duplicate submissions are refused when JTL already holds an order marked within this window. */
const SUBMISSION_LOOKBACK_MS = 24 * 3600 * 1000;

// Bounds the detail reads one created-order lookup may perform.
const CREATED_SCAN_PAGES = 5;
const CREATED_SCAN_PAGE_SIZE = 100;

/** Marks an order so Luma can find it again; JTL never sends the internal comment to a supplier. */
const lumaOrderMarker = (lumaOrderId: string) => `luma-po:${lumaOrderId}`;

function notDispatched(
  code: ConnectorFailure['code'],
  failure?: ConnectorFailure,
): never {
  throw new ConnectorError({
    ...(failure ?? { code, retry: 'never' }),
    code,
    effect: 'none',
    dispatch: 'not_dispatched',
  });
}

/** Purchase orders are read with their detail; only allowlisted fields leave the adapter. */
function toSupplierOrder(order: PurchaseOrder): SupplierOrderSnapshot {
  // ERP 2.2 purchase-order lines carry no unit. Luma submits countable items only, so its own
  // orders are in `each`; for orders created elsewhere the unit is unknown.
  const unit = order.lumaOrderIds.length === 1 ? 'each' : 'unknown';

  return {
    supplier: ref(order.supplierId),
    orderNumber: text(order.orderNumber),
    lumaOrderId:
      order.lumaOrderIds.length === 1 ? order.lumaOrderIds[0]! : null,
    status: statuses[order.status] ?? 'unknown',
    requestedDeliveryDate: order.requestedDeliveryDate ?? null,
    confirmed: order.isConfirmed,
    createdAt: order.createdAt ?? null,
    lines: order.lineItems
      .filter((line) => line.lineItemType === ITEM_LINE)
      .map((line) => ({
        id: ref(line.lineItemId, order.purchaseOrderId),
        sku: line.itemId ? ref(line.itemId) : null,
        itemNumber: text(line.itemNumber),
        quantity: { amount: line.quantity, unit },
        deliveredQuantity: line.deliveredQuantity,
        confirmedQuantity: line.confirmedQuantity ?? null,
        confirmedDeliveryDate: line.confirmedDeliveryDate ?? null,
        confirmed: line.isLineItemConfirmed ?? null,
        requestedDeliveryDate: line.deliveryDate ?? null,
      })),
  };
}

/**
 * Supplier and purchase-order reads plus purchase-order submission. Submission is a high-risk,
 * provider-keyed write: it prices lines from JTL's supplier assignments, refuses when JTL already
 * holds an order for the same Luma order, and reports any response after dispatch that does not
 * establish the outcome as uncertain.
 */
export function createJtlPurchaseOrderCapabilities(
  options: JtlConnectorOptions,
): ConnectorConnection['capabilities'] {
  const client = createClient(options);
  const now = options.now ?? (() => new Date());
  const nextId = options.id ?? randomUUID;

  function check(context: InvocationContext) {
    if (
      context.tenant.tenantId !== options.tenantId ||
      context.connectionId !== options.connectionId ||
      context.provider !== 'jtl'
    )
      fail('unavailable');
  }

  /** Collects allowlisted payloads and observations for one capability call. */
  function session(capability: ReadKind) {
    const observedAt = now().toISOString();
    const payloads = createPayloadCapture(options.rawRetentionMs, now);
    const capture = payloads.capture;
    const observations: Observation<unknown>[] = [];

    async function page<T extends z.ZodTypeAny>(
      path: string,
      schema: T,
      number: number,
      size: number,
      query: Record<string, string> = {},
    ) {
      const result = capture(
        s.page(schema),
        await client.request(path, {
          ...query,
          pageNumber: String(number),
          pageSize: String(size),
        }),
      );
      const remaining = Math.max(0, result.totalItems - (number - 1) * size);
      const hasNext = number * size < result.totalItems;
      if (
        result.pageNumber !== number ||
        result.pageSize !== size ||
        result.items.length !== Math.min(size, remaining) ||
        (result.hasNextPage !== undefined && result.hasNextPage !== hasNext)
      )
        fail('invalid_response');

      return {
        items: result.items as z.infer<T>[],
        hasNext,
        total: result.totalItems,
      };
    }

    function emit(
      resource: 'supplier' | 'purchase_order',
      id: string,
      sourceUpdatedAt: string | null,
      data: SupplierSnapshot | SupplierOrderSnapshot,
    ) {
      observations.push({
        id: nextId(),
        source: {
          ...ref(id),
          tenantId: options.tenantId,
          connectionId: options.connectionId,
          provider: 'jtl',
          resource,
        },
        kind: 'snapshot',
        observedAt,
        sourceUpdatedAt,
        sourceRevision: null,
        adapterVersion,
        schemaVersion: 1,
        data,
      });
    }

    async function purchaseOrder(id: string) {
      const order = capture(
        s.purchaseOrder,
        await client.request(`purchase-orders/${id}`),
      );
      if (
        order.purchaseOrderId !== id ||
        new Set(order.lineItems.map((line) => line.lineItemId)).size !==
          order.lineItems.length
      )
        fail('invalid_response');

      return order;
    }

    /** Finds orders marked for `lumaOrderId` created after `since`, within a bounded scan. */
    async function created(lumaOrderId: string, since: Date) {
      const matches: PurchaseOrder[] = [];
      // JTL's `createdAtAfter` is exclusive; one second keeps the window inclusive.
      const query = {
        createdAtAfter: new Date(since.getTime() - 1000).toISOString(),
      };
      for (let number = 1; number <= CREATED_SCAN_PAGES; number++) {
        const current = await page(
          'purchase-orders',
          s.purchaseOrderListItem,
          number,
          CREATED_SCAN_PAGE_SIZE,
          query,
        );
        for (const row of current.items) {
          const order = await purchaseOrder(row.purchaseOrderId);
          if (order.lumaOrderIds.includes(lumaOrderId)) matches.push(order);
        }
        if (!current.hasNext) return { matches, complete: true };
      }

      return { matches, complete: false };
    }

    async function finish<K extends ReadKind>(
      kind: K,
      page: {
        nextCursor: string | null;
        completeness: 'complete' | 'partial';
        total?: number;
      },
    ): Promise<CapabilityOutput<K>> {
      const keys = observations.map((value) => value.source.externalId);
      if (new Set(keys).size !== keys.length) fail('invalid_response');
      const result = parse<unknown>(outputs[kind], {
        items: observations,
        ...page,
      }) as CapabilityOutput<K>;
      await options.recordObservations({
        tenantId: options.tenantId,
        connectionId: options.connectionId,
        apiVersion: API_VERSION,
        capability,
        observations: result.items,
        ...payloads.raw(),
      });

      return result;
    }

    return { capture, page, emit, purchaseOrder, created, finish };
  }

  function binding(capability: ReadKind, limit: number) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          options.tenantId,
          options.connectionId,
          client.binding,
          API_VERSION,
          capability,
          limit,
        ]),
      )
      .digest('hex');
  }

  function decodeCursor(cursor: string | undefined, expected: string) {
    if (!cursor) return 1;
    const decoded = pageCursor.decode(cursor);
    if (decoded.binding !== expected) fail('invalid_input');

    return decoded.page;
  }

  const encodeCursor = (value: string, page: number) =>
    pageCursor.encode({ binding: value, page });

  const readDescriptor = {
    version: '0',
    minimumRisk: 'low',
    idempotency: 'none',
    retry: { maxAttempts: 3, initialDelayMs: 1000 },
  } as const;

  async function readPurchaseOrders(
    input: CapabilityInput<'purchase-orders.read'>,
  ) {
    const current = session('purchase-orders.read');
    const emit = (order: PurchaseOrder) =>
      current.emit(
        'purchase_order',
        order.purchaseOrderId,
        null,
        toSupplierOrder(order),
      );
    if (input.order) {
      emit(await current.purchaseOrder(input.order.externalId));

      return current.finish('purchase-orders.read', {
        nextCursor: null,
        completeness: 'complete',
      });
    }
    if (input.created) {
      const found = await current.created(
        input.created.lumaOrderId,
        new Date(input.created.createdSince),
      );
      const matches = found.matches
        .sort(
          (a, b) =>
            (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
            a.purchaseOrderId.localeCompare(b.purchaseOrderId),
        )
        .slice(0, input.limit);
      matches.forEach(emit);

      return current.finish('purchase-orders.read', {
        nextCursor: null,
        completeness:
          found.complete && found.matches.length <= input.limit
            ? 'complete'
            : 'partial',
      });
    }
    const key = binding('purchase-orders.read', input.limit);
    const number = decodeCursor(input.cursor, key);
    const result = await current.page(
      'purchase-orders',
      s.purchaseOrderListItem,
      number,
      input.limit,
    );
    for (const row of result.items)
      emit(await current.purchaseOrder(row.purchaseOrderId));

    return current.finish('purchase-orders.read', {
      nextCursor: result.hasNext ? encodeCursor(key, number + 1) : null,
      completeness: 'complete',
      total: result.total,
    });
  }

  const suppliers: CapabilityHandler<'suppliers.read'> = {
    descriptor: readDescriptor,
    parseInput: (value) =>
      s.purchaseOrderInputs['suppliers.read'].parse(
        value,
      ) as CapabilityInput<'suppliers.read'>,
    parseOutput: (value) =>
      outputs['suppliers.read'].parse(
        value,
      ) as CapabilityOutput<'suppliers.read'>,
    async run(context, input) {
      check(context);
      const current = session('suppliers.read');
      if (input.supplier) {
        const supplier = current.capture(
          s.supplierDetail,
          await client.request(`suppliers/${input.supplier.externalId}`),
        );
        if (supplier.id !== input.supplier.externalId) fail('invalid_response');
        current.emit('supplier', supplier.id, null, {
          name: text(supplier.companyName ?? supplier.name),
          number: text(supplier.supplierNumber),
          active: supplier.isActive,
          email: email(supplier.contact?.emailAddress),
        });

        return current.finish('suppliers.read', {
          nextCursor: null,
          completeness: 'complete',
        });
      }
      const key = binding('suppliers.read', input.limit);
      const number = decodeCursor(input.cursor, key);
      const result = await current.page(
        'suppliers',
        s.supplier,
        number,
        input.limit,
      );
      for (const supplier of result.items)
        current.emit('supplier', supplier.id, null, {
          name: text(supplier.companyName ?? supplier.name),
          number: text(supplier.supplierNumber),
          // The ERP 2.2 overview lists active default-type suppliers only.
          active: true,
          // Contact details are only in the supplier detail.
          email: null,
        });

      return current.finish('suppliers.read', {
        nextCursor: result.hasNext ? encodeCursor(key, number + 1) : null,
        completeness: 'complete',
        total: result.total,
      });
    },
  };

  const purchaseOrders: CapabilityHandler<'purchase-orders.read'> = {
    descriptor: readDescriptor,
    parseInput: (value) =>
      s.purchaseOrderInputs['purchase-orders.read'].parse(
        value,
      ) as CapabilityInput<'purchase-orders.read'>,
    parseOutput: (value) =>
      outputs['purchase-orders.read'].parse(
        value,
      ) as CapabilityOutput<'purchase-orders.read'>,
    async run(context, input) {
      check(context);

      return readPurchaseOrders(input);
    },
  };

  /** Reads every supplier assignment of the item and returns the one for `supplierId`. */
  async function assignment(itemId: string, supplierId: string) {
    const current = session('purchase-orders.read');
    for (let number = 1; number <= 10; number++) {
      const result = await current.page(
        `items/${itemId}/suppliers`,
        s.itemSupplier,
        number,
        100,
      );
      const found = result.items.find(
        (row) => row.supplierId === supplierId && row.itemId === itemId,
      );
      if (found) return found;
      if (!result.hasNext) return null;
    }
    fail('invalid_response');
  }

  const submit: CapabilityHandler<'purchase-orders.submit'> = {
    descriptor: {
      version: '0',
      minimumRisk: 'high',
      permission: jtlPermissions.purchaseOrders,
      idempotency: 'provider_key',
      retry: { maxAttempts: 1, initialDelayMs: 0 },
    },
    parseInput: (value) =>
      s.purchaseOrderInputs['purchase-orders.submit'].parse(value),
    parseOutput: (value) =>
      z
        .object({
          status: z.literal('accepted'),
          evidenceRefs: z.array(z.string().min(1)).length(1),
          providerRequestId: z.string().nullable(),
        })
        .strict()
        .parse(value),
    async run(context, value) {
      if (
        context.tenant.tenantId !== options.tenantId ||
        context.connectionId !== options.connectionId ||
        context.provider !== 'jtl'
      )
        notDispatched('unavailable');
      if (!context.idempotencyKey?.trim()) notDispatched('invalid_input');
      const parsed =
        s.purchaseOrderInputs['purchase-orders.submit'].safeParse(value);
      if (!parsed.success) notDispatched('invalid_input');
      const input = parsed.data;

      let items: {
        itemId: string;
        quantity: number;
        netPurchasePriceAmount: number;
        vatRatePercentage: number;
      }[];
      try {
        items = [];
        for (const line of input.lines) {
          const found = await assignment(
            line.sku.externalId,
            input.supplier.externalId,
          );
          // JTL rejects items not assigned to the supplier; Luma never owns purchase prices.
          if (!found || found.netPurchasePrice == null || found.vatRate == null)
            notDispatched('conflict');
          items.push({
            itemId: line.sku.externalId,
            quantity: Number(line.quantity.amount),
            netPurchasePriceAmount: Number(found.netPurchasePrice),
            vatRatePercentage: Number(found.vatRate),
          });
        }
        const existing = await readPurchaseOrders({
          limit: 25,
          created: {
            lumaOrderId: input.lumaOrderId,
            createdSince: new Date(
              now().getTime() - SUBMISSION_LOOKBACK_MS,
            ).toISOString(),
          },
        });
        // An existing order, or a scan that cannot rule one out, must be reconciled instead.
        if (existing.items.length || existing.completeness !== 'complete')
          notDispatched('conflict');
      } catch (error) {
        if (error instanceof ConnectorError)
          notDispatched(error.failure.code, error.failure);
        notDispatched('internal');
      }

      // Execution binds this logical key to immutable intent. Do not derive a new key from changed parameters.
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            options.tenantId,
            options.connectionId,
            client.binding,
            'purchase-orders.submit',
            context.idempotencyKey,
          ]),
        )
        .digest('hex');
      let providerRequestId: string | null = null;
      const response = await client.request(
        'purchase-orders',
        {},
        {
          method: 'POST',
          body: {
            supplierId: input.supplier.externalId,
            // Midday UTC keeps the calendar date stable across JTL server time zones.
            requestedDeliveryDate: `${input.requestedDeliveryDate}T12:00:00Z`,
            items,
            externalOrderNumber: input.reference.slice(0, 255),
            internalComment: `Created by Luma · ${lumaOrderMarker(input.lumaOrderId)}`,
          },
          idempotencyKey: key,
          receipt: (id) => {
            providerRequestId = id;
          },
        },
      );
      const created = s.purchaseOrderCreated.safeParse(response);
      if (!created.success)
        throw new ConnectorError({
          code: 'invalid_response',
          ...(providerRequestId ? { providerRequestId } : {}),
          effect: 'unknown',
          retry: 'reconcile',
        });

      return {
        status: 'accepted',
        evidenceRefs: [
          acceptanceId(
            options.tenantId,
            options.connectionId,
            created.data.purchaseOrderId,
          ),
        ],
        providerRequestId,
      };
    },
  };

  return {
    'suppliers.read': suppliers,
    'purchase-orders.read': purchaseOrders,
    ...(options.purchaseOrderRevisions
      ? {
          'purchase-orders.revise': createJtlPurchaseOrderRevision(
            options,
            toSupplierOrder,
          ),
        }
      : {}),
    ...(options.purchaseOrderActions
      ? { 'purchase-orders.submit': submit }
      : {}),
  };
}
