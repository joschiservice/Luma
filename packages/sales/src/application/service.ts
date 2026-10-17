import type { TenantContext } from '@luma/identity';
import {
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { conflict, forbidden, invalid, notFound } from '@luma/platform';

import type { SalesEdit, SalesOrder } from '../domain/order.js';
import { publishedOrder, units } from '../domain/order.js';

export interface SalesTransaction {
  /** Locks and reads this tenant's record, or returns null before intake. */
  get(orderId: string, lock?: boolean): Promise<SalesOrder | null>;
  /** Copies an eligible current Shopify projection and establishes its internal source identity. */
  intake(orderId: string, connectionId: string): Promise<SalesOrder>;
  /** Saves only sales-owned tables in the current transaction. */
  save(order: SalesOrder): Promise<void>;
  /** Publishes through Connections and Orders owners in this same transaction. */
  publish(order: SalesOrder): Promise<void>;
  /** Checks current lifecycle and line authority under the authority configuration lock. */
  requireAuthority(order: SalesOrder): Promise<void>;
  /** Inventory reconciles exact remaining allocations before the Sales change commits. */
  reconcileStock(
    previous: SalesOrder,
    next: SalesOrder,
    commandId: string,
  ): Promise<void>;
  /** Writes an audit event containing record identity and version, never addresses. */
  audit(
    order: SalesOrder,
    commandId: string,
    operation: 'accepted' | 'edited',
  ): Promise<void>;
  /** An identical retry returns its original result; a different command body is rejected. */
  receipt(
    commandId: string,
    orderId: string,
    input: SalesEdit,
  ): Promise<SalesOrder | null>;
  /** Stores the committed command result for retry after a lost response. */
  remember(
    commandId: string,
    orderId: string,
    input: SalesEdit,
    order: SalesOrder,
  ): Promise<void>;
}

export interface SalesDependencies {
  refreshContext(context: TenantContext): Promise<TenantContext>;
  enabled(context: TenantContext): Promise<boolean>;
  atomic<T>(
    context: TenantContext,
    operation: (tx: SalesTransaction) => Promise<T>,
    orderId?: string,
  ): Promise<T>;
}

/** Provides release-gated, tenant-scoped intake and edits. Writes require refreshed sales permission. */
export function createSalesService(deps: SalesDependencies) {
  async function access(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id) throw forbidden('Actor changed');
    if (!(await deps.enabled(fresh)))
      throw notFound('Luma orders are unavailable');
    requirePermission(fresh, 'sales.manage');

    return fresh;
  }

  return {
    /** Supplies redacted exact demand to Inventory; new allocation requires native authority, compensation can inspect retained records. */
    async stockDemand(
      context: TenantContext,
      orderId: string,
      requireAuthority = true,
    ): Promise<SalesStockDemand | null> {
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      if (fresh.actor.id !== context.actor.id) throw forbidden('Actor changed');
      requirePermission(fresh, 'inventory.manage');
      requirePermission(fresh, 'orders.read');
      if (requireAuthority && !(await deps.enabled(fresh)))
        throw notFound('Luma orders are unavailable');

      return deps.atomic(
        fresh,
        async (tx) => {
          const order = await tx.get(orderId, false);
          if (!order) return null;
          if (requireAuthority) await tx.requireAuthority(order);

          return {
            orderId: order.orderId,
            version: order.version,
            status: order.status,
            connectionId: order.connectionId,
            lines: order.lines.map((line) => ({
              id: line.id,
              skuId: line.skuId,
              skuCode: line.skuCode,
              title: line.title,
              unit: line.unit,
              currentQuantity:
                order.status === 'cancelled' ? '0' : line.currentQuantity,
            })),
          };
        },
        orderId,
      );
    },
    /** Exposes the workspace release state without provisioning a connection or records. */
    enabled: deps.enabled,
    /** Reads the tenant record, including personal addresses, with current sales permission. */
    async get(context: TenantContext, orderId: string) {
      const fresh = await access(context);

      return deps.atomic(fresh, (tx) => tx.get(orderId, false), orderId);
    },
    /** Accepts a validated Shopify order once; record, source evidence and audit commit together. */
    async accept(
      context: TenantContext,
      orderId: string,
      connectionId: string,
    ) {
      const fresh = await access(context);
      requireChangesAllowed(fresh);
      requirePermission(fresh, 'sync.manage');

      return deps.atomic(
        fresh,
        async (tx) => {
          const previous = await tx.get(orderId);
          if (previous) return previous;
          const order = await tx.intake(orderId, connectionId);
          await tx.save(order);
          await tx.publish(order);
          await tx.audit(order, order.id, 'accepted');

          return order;
        },
        orderId,
      );
    },
    /** Applies a validated edit with optimistic versions, explicit authority and retry receipts. */
    async edit(context: TenantContext, orderId: string, input: SalesEdit) {
      const fresh = await access(context);
      requireChangesAllowed(fresh);
      requirePermission(fresh, 'sync.manage');

      return deps.atomic(
        fresh,
        async (tx) => {
          const retry = await tx.receipt(input.commandId, orderId, input);
          if (retry) return retry;
          const previous = await tx.get(orderId);
          if (!previous) throw notFound('Luma order not found');
          await tx.requireAuthority(previous);
          if (previous.version !== input.version)
            throw conflict('Order changed; reload and retry');
          if (
            previous.status === 'cancelled' &&
            input.status &&
            input.status !== 'cancelled'
          )
            throw conflict('A cancelled order cannot be reopened');
          const changes = new Map(
            input.lines?.map((line) => [line.id, line.currentQuantity]),
          );
          if (
            changes.size !== (input.lines?.length ?? 0) ||
            [...changes.keys()].some(
              (id) => !previous.lines.some((line) => line.id === id),
            )
          )
            throw invalid(
              'Each edited line must belong to this order and occur once',
            );
          const lines = previous.lines.map((line) => {
            const value = changes.get(line.id);
            if (value === undefined) return line;
            if (units(value) > units(line.quantity))
              throw invalid('Current units cannot exceed ordered units');

            return units(value) === units(line.currentQuantity)
              ? line
              : { ...line, currentQuantity: value };
          });
          const order: SalesOrder = {
            ...previous,
            status: input.status ?? previous.status,
            billingAddress:
              input.billingAddress === undefined
                ? previous.billingAddress
                : input.billingAddress,
            shippingAddress:
              input.shippingAddress === undefined
                ? previous.shippingAddress
                : input.shippingAddress,
            lines,
            // Shipping, discounts and tax adjustments are not inferred from line prices.
            total: lines.some((line, index) => line !== previous.lines[index])
              ? null
              : previous.total,
          };
          if (JSON.stringify(order) !== JSON.stringify(previous)) {
            order.version += 1;
            order.updatedAt = new Date().toISOString();
            await tx.reconcileStock(previous, order, input.commandId);
            await tx.save(order);
            if (
              JSON.stringify(publishedOrder(order)) !==
              JSON.stringify(publishedOrder(previous))
            )
              await tx.publish(order);
            await tx.audit(order, input.commandId, 'edited');
          }
          await tx.remember(input.commandId, orderId, input, order);

          return order;
        },
        orderId,
      );
    },
  };
}

export type SalesService = ReturnType<typeof createSalesService>;

/** Inventory can inspect native demand without customer identities, addresses or monetary fields. */
interface SalesStockDemand {
  orderId: string;
  version: number;
  status: SalesOrder['status'];
  connectionId: string;
  lines: {
    id: string;
    skuId: string | null;
    skuCode: string | null;
    title: string | null;
    unit: string;
    currentQuantity: string;
  }[];
}
