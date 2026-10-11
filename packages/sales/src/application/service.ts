import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import type { SalesEdit, SalesOrder } from '../domain/order.js';
import { publishedOrder, units } from '../domain/order.js';

export interface SalesTransaction {
  /** Locks and reads this tenant's record, or returns null before intake. */
  get(orderId: string): Promise<SalesOrder | null>;
  /** Copies an eligible current Shopify projection and establishes its internal source identity. */
  intake(orderId: string, connectionId: string): Promise<SalesOrder>;
  /** Saves only sales-owned tables in the current transaction. */
  save(order: SalesOrder): Promise<void>;
  /** Publishes through Connections and Orders owners in this same transaction. */
  publish(order: SalesOrder): Promise<void>;
  /** Checks current lifecycle and line authority under the authority configuration lock. */
  requireAuthority(order: SalesOrder): Promise<void>;
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
  ): Promise<T>;
}

/** Provides release-gated, tenant-scoped intake and edits. Writes require refreshed sales permission. */
export function createSalesService(deps: SalesDependencies) {
  async function access(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    if (!(await deps.enabled(fresh)))
      throw new IdentityError(404, 'NOT_FOUND', 'Luma orders are unavailable');
    requirePermission(fresh, 'sales.manage');

    return fresh;
  }

  return {
    /** Exposes the workspace release state without provisioning a connection or records. */
    enabled: deps.enabled,
    /** Reads the tenant record, including personal addresses, with current sales permission. */
    async get(context: TenantContext, orderId: string) {
      const fresh = await access(context);

      return deps.atomic(fresh, (tx) => tx.get(orderId));
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

      return deps.atomic(fresh, async (tx) => {
        const previous = await tx.get(orderId);
        if (previous) return previous;
        const order = await tx.intake(orderId, connectionId);
        await tx.save(order);
        await tx.publish(order);
        await tx.audit(order, order.id, 'accepted');

        return order;
      });
    },
    /** Applies a validated edit with optimistic versions, explicit authority and retry receipts. */
    async edit(context: TenantContext, orderId: string, input: SalesEdit) {
      const fresh = await access(context);
      requireChangesAllowed(fresh);
      requirePermission(fresh, 'sync.manage');

      return deps.atomic(fresh, async (tx) => {
        const retry = await tx.receipt(input.commandId, orderId, input);
        if (retry) return retry;
        const previous = await tx.get(orderId);
        if (!previous)
          throw new IdentityError(404, 'NOT_FOUND', 'Luma order not found');
        await tx.requireAuthority(previous);
        if (previous.version !== input.version)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Order changed; reload and retry',
          );
        if (
          previous.status === 'cancelled' &&
          input.status &&
          input.status !== 'cancelled'
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'A cancelled order cannot be reopened',
          );
        const changes = new Map(
          input.lines?.map((line) => [line.id, line.currentQuantity]),
        );
        if (
          changes.size !== (input.lines?.length ?? 0) ||
          [...changes.keys()].some(
            (id) => !previous.lines.some((line) => line.id === id),
          )
        )
          throw new IdentityError(
            422,
            'VALIDATION_ERROR',
            'Each edited line must belong to this order and occur once',
          );
        const lines = previous.lines.map((line) => {
          const value = changes.get(line.id);
          if (value === undefined) return line;
          if (units(value) > units(line.quantity))
            throw new IdentityError(
              422,
              'VALIDATION_ERROR',
              'Current units cannot exceed ordered units',
            );

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
      });
    },
  };
}

export type SalesService = ReturnType<typeof createSalesService>;
