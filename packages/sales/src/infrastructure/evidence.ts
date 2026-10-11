import { createHash, randomUUID } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type {
  AuthorityReader,
  InstalledConnection,
  SourceRecords,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { hasPermission, IdentityError } from '@luma/identity';
import type { CanonicalSnapshot, CommerceProjections } from '@luma/orders';
import type { SqlTransaction } from '@luma/platform';

import type { SalesTransaction } from '../application/service.js';
import type { SalesOrder } from '../domain/order.js';
import { publishedOrder, units } from '../domain/order.js';
import { createSalesStore } from './store.js';

/** Adapts sales intake and publication to the evidence owners in one caller-owned transaction. */
export function createSalesPersistence(
  tx: SqlTransaction,
  context: TenantContext,
  ports: {
    sources: SourceRecords;
    orders: CommerceProjections;
    source(context: TenantContext): Promise<InstalledConnection>;
    authority: AuthorityReader;
    audit: AuditLog;
  },
): SalesTransaction {
  const commerce = ports;

  return {
    ...createSalesStore(tx, context.tenantId, context.actor.id),
    intake: async (orderId, connectionId) => {
      const projections = await commerce.orders.current(context, orderId);
      const snapshot = projections.find(
        (p) => p.snapshot.connectionId === connectionId,
      )?.snapshot;
      const source = await tx.query<{ provider: string; status: string }>(
        "SELECT COALESCE(document->>'provider',document->'target'->>'kind') AS provider,document->>'status' AS status FROM connector_installations WHERE tenant_id=$1 AND id=$2 FOR SHARE",
        [context.tenantId, connectionId],
      );
      if (
        !snapshot ||
        snapshot.deleted ||
        snapshot.data.type !== 'order' ||
        source.rows[0]?.provider !== 'shopify' ||
        !['active', 'degraded'].includes(source.rows[0].status)
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'A current Shopify order is required',
        );
      const data = snapshot.data;
      if (
        !['open', 'completed', 'cancelled'].includes(data.status) ||
        !data.displayNumber ||
        !data.total
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Order number, status and currency must be known before intake',
        );
      // Customer links are erasable, separate from the immutable order evidence.
      const customers = hasPermission(context, 'customers.read')
        ? await tx.query<{ id: string }>(
            `SELECT p.id FROM connector_source_mappings m
          JOIN customer_orders o ON o.tenant_id=m.tenant_id AND o.connection_id=m.connection_id AND o.order_scope_key=m.scope_key AND o.order_external_id=m.external_id
          JOIN customer_profiles p ON p.tenant_id=o.tenant_id AND p.connection_id=o.connection_id AND p.external_id=o.customer_external_id
          WHERE m.tenant_id=$1 AND m.connection_id=$2 AND m.resource='order' AND m.canonical_id=$3`,
            [context.tenantId, connectionId, orderId],
          )
        : null;
      const connection = await ports.source(context);
      const order: SalesOrder = {
        id: randomUUID(),
        orderId,
        connectionId: connection.id,
        version: 1,
        number: data.displayNumber,
        status: orderStatus(data.status),
        paymentStatus: paymentStatus(data.paymentStatus),
        customerId: customers?.rows[0]?.id ?? null,
        billingAddress: null,
        shippingAddress: null,
        currency: data.total.currency,
        channel: 'shopify',
        total: data.total.amount,
        placedAt: data.placedAt ?? null,
        dueAt: data.dueAt ?? null,
        updatedAt: new Date().toISOString(),
        lines: data.lines.map((line) => ({
          id: line.id,
          skuId: line.skuId,
          skuCode: line.skuCode ?? null,
          title: line.title ?? null,
          quantity: line.quantity,
          currentQuantity:
            line.currentQuantity ??
            (line.cancelledQuantity === null
              ? unknownQuantity()
              : subtract(line.quantity, line.cancelledQuantity)),
          unit: line.unit,
          unitPrice:
            line.unitPrice && line.unitPrice.currency === data.total?.currency
              ? line.unitPrice.amount
              : null,
          taxRate: line.taxRate ?? null,
        })),
      };

      try {
        if (
          order.number.length > 200 ||
          order.lines.length > 1000 ||
          !/^[A-Z]{3}$/.test(order.currency)
        )
          throw new Error('Unsupported order');
        if (order.total !== null) units(order.total);
        for (const line of order.lines) {
          if (
            !line.unit ||
            line.unit.length > 64 ||
            units(line.quantity) === 0n ||
            units(line.currentQuantity) > units(line.quantity)
          )
            throw new Error('Unsupported quantities');
          if (line.unitPrice !== null) units(line.unitPrice);
          if (line.taxRate !== null && units(line.taxRate) > units('1'))
            throw new Error('Unsupported tax rate');
        }
      } catch {
        throw new IdentityError(
          409,
          'CONFLICT',
          'The source order cannot be represented as a Luma record',
        );
      }

      return order;
    },
    requireAuthority: async (order) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `source-authority:${context.tenantId}`,
      ]);
      const current = await ports.authority.read(context);
      if (
        !['order_lifecycle', 'order_lines'].every((group) =>
          current.groups.some(
            (fact) =>
              fact.group === group &&
              fact.state === 'resolved' &&
              fact.basis === 'override' &&
              fact.connectionId === order.connectionId,
          ),
        )
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Select Luma ERP for order lifecycle and lines in source authority before editing',
        );
    },
    publish: async (order) => {
      const observationId = randomUUID();
      const source = {
        tenantId: context.tenantId,
        connectionId: order.connectionId,
        provider: 'luma-erp',
        resource: 'order' as const,
        externalId: order.id,
        scopeKey: '',
      };
      const data = publishedOrder(order);
      await commerce.sources.record(
        context,
        `sales:${order.id}:${order.version}`,
        {
          capability: 'orders.read',
          observation: {
            id: observationId,
            source,
            kind: 'snapshot',
            schemaVersion: 1,
            observedAt: order.updatedAt,
            sourceUpdatedAt: order.updatedAt,
            sourceRevision: String(order.version),
            adapterVersion: 'luma-erp/1',
            data: {
              displayNumber: data.displayNumber,
              status: order.status,
              paymentStatus: order.paymentStatus,
              placedAt: data.placedAt,
              dueAt: data.dueAt,
              total: data.total,
              lines: data.lines.map(({ skuId, unit, ...line }) => ({
                ...line,
                id: { externalId: line.id, scopeKey: order.id },
                sku: skuId ? { externalId: skuId, scopeKey: '' } : null,
                quantity: { amount: line.quantity, unit },
                currentQuantity: {
                  amount: line.currentQuantity,
                  unit,
                },
                cancelledQuantity: {
                  amount: line.cancelledQuantity,
                  unit,
                },
              })),
            },
          },
        },
      );
      if (order.version === 1)
        await commerce.sources.bindMany(context, [
          {
            source,
            canonicalId: order.orderId,
            observationId,
            method: 'Accepted storefront order into Luma',
          },
          ...order.lines.map((line) => ({
            source: {
              ...source,
              resource: 'order_line' as const,
              externalId: line.id,
              scopeKey: order.id,
            },
            canonicalId: line.id,
            observationId,
            method: 'Accepted storefront order line into Luma',
          })),
          ...order.lines.flatMap((line) =>
            line.skuId
              ? [
                  {
                    source: {
                      ...source,
                      resource: 'sku' as const,
                      externalId: line.skuId,
                      scopeKey: '',
                    },
                    canonicalId: line.skuId,
                    observationId,
                    method: 'Accepted storefront SKU into Luma',
                  },
                ]
              : [],
          ),
        ]);
      const snapshot: CanonicalSnapshot = {
        entityId: order.orderId,
        connectionId: order.connectionId,
        observationId,
        schemaVersion: 4,
        kind: 'order',
        normalizerVersion: 'commerce/4',
        mappingVersion: hash(
          JSON.stringify([
            order.orderId,
            order.lines.map((line) => [line.id, line.skuId]),
          ]),
        ),
        observedAt: order.updatedAt,
        sourceUpdatedAt: order.updatedAt,
        sourceRevision: String(order.version),
        deleted: false,
        data,
      };
      await commerce.orders.project(context, snapshot);
    },
    audit: (order, commandId, operation) =>
      ports.audit.append({
        id: randomUUID(),
        tenantId: context.tenantId,
        eventKey: `sales:${commandId}`,
        eventType: `sales.order.${operation}`,
        schemaVersion: 1,
        occurredAt: order.updatedAt,
        actor: { kind: 'user', id: context.actor.id },
        correlationId: context.requestId,
        proposalId: order.id,
        actionHash: hash(`${order.id}:${order.version}`),
        connectionId: order.connectionId,
        evidenceRefs: [],
        details: { orderId: order.orderId, version: String(order.version) },
      }),
  };
}

function unknownQuantity(): never {
  throw new IdentityError(
    409,
    'CONFLICT',
    'Current line quantities must be known before intake',
  );
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function subtract(left: string, right: string) {
  const scale = 1_000_000n;
  const parse = (v: string) => {
    const [whole, fraction = ''] = v.split('.');

    return BigInt(whole!) * scale + BigInt(fraction.padEnd(6, '0'));
  };
  const value = parse(left) - parse(right);

  return `${value / scale}.${(value % scale).toString().padStart(6, '0')}`;
}

function paymentStatus(value: string): SalesOrder['paymentStatus'] {
  switch (value) {
    case 'pending':
    case 'authorized':
    case 'paid':
    case 'partially_refunded':
    case 'refunded':
    case 'failed':
      return value;
    default:
      return 'unknown';
  }
}

function orderStatus(value: string): SalesOrder['status'] {
  if (value === 'open' || value === 'completed' || value === 'cancelled')
    return value;
  throw new IdentityError(409, 'CONFLICT', 'Order status must be known');
}
