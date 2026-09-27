import type { AuditEntry } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import { IdentityError, requireRole, requireTenant } from '@luma/identity';

import type {
  PurchaseOrder,
  PurchaseOrderInput,
  Supplier,
  SupplierInput,
  TransitionInput,
} from '../domain/procurement.js';
import { nextStatuses, purchaseOrderProblem } from '../domain/procurement.js';

export interface ProcurementEvent {
  id: string;
  commandId?: string | undefined;
  occurredAt: string;
  actorId: string;
  from: PurchaseOrder['status'] | null;
  to: PurchaseOrder['status'];
  revision: number;
  reason: string;
}

export interface ProcurementTransaction {
  /** Lists tenant-owned supplier records. */
  suppliers(): Promise<Supplier[]>;
  /** Lists tenant-owned purchase orders, newest first. */
  orders(): Promise<PurchaseOrder[]>;
  /** Returns a tenant supplier or null. */
  supplier(id: string): Promise<Supplier | null>;
  /** Returns a tenant purchase order or null. */
  order(id: string): Promise<PurchaseOrder | null>;
  /** Inserts an immutable supplier. */
  insertSupplier(supplier: Supplier): Promise<void>;
  /** Inserts a purchase order with immutable lines and provenance. */
  insertOrder(order: PurchaseOrder): Promise<void>;
  /** Updates only lifecycle fields. */
  updateOrder(order: PurchaseOrder): Promise<void>;
  /** Reads the original result of a committed command. */
  command(
    id: string,
  ): Promise<{ digest: string; result: Supplier | PurchaseOrder } | null>;
  /** Records a command's result in the business transaction. */
  saveCommand(
    id: string,
    digest: string,
    result: Supplier | PurchaseOrder,
  ): Promise<void>;
  /** Appends audit evidence in the business transaction. */
  audit(entry: AuditEntry): Promise<void>;
  /** Reads ordered lifecycle evidence. */
  history(id: string): Promise<ProcurementEvent[]>;
}

export interface ProcurementStore {
  /** Serializes writes per tenant and rolls back records, commands and audit together. */
  transaction<T>(
    tenantId: string,
    write: boolean,
    operation: (tx: ProcurementTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Owns procurement authorization, durable command retries and explicit lifecycle changes. */
export function createProcurementService(deps: {
  store: ProcurementStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  digest(value: unknown): string;
  now(): Date;
  id(): string;
  parseSupplier(input: unknown): SupplierInput;
  parseOrder(input: unknown): PurchaseOrderInput;
  parseTransition(input: unknown): TransitionInput;
}) {
  async function authorize(context: TenantContext, write = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requireRole(
      fresh,
      write ? ['owner', 'admin'] : ['owner', 'admin', 'member'],
    );
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

    return fresh;
  }

  function conflict(message: string): never {
    throw new IdentityError(409, 'CONFLICT', message);
  }

  async function command<T extends Supplier | PurchaseOrder>(
    context: TenantContext,
    id: string,
    request: unknown,
    operation: (tx: ProcurementTransaction) => Promise<T>,
  ): Promise<T> {
    const digest = deps.digest({ actorId: context.actor.id, request });

    return deps.store.transaction(context.tenantId, true, async (tx) => {
      const prior = await tx.command(id);
      if (prior) {
        if (prior.digest !== digest)
          conflict(
            'This request ID was already used. Refresh before trying again.',
          );

        return prior.result as T;
      }
      const result = await operation(tx);
      await tx.saveCommand(id, digest, result);

      return result;
    });
  }

  function audit(
    context: TenantContext,
    order: PurchaseOrder,
    eventId: string,
    from: PurchaseOrder['status'] | null,
    reason: string,
  ): AuditEntry {
    return {
      id: deps.id(),
      tenantId: context.tenantId,
      eventKey: `procurement:${eventId}`,
      eventType:
        from === null
          ? 'purchase_order.created'
          : 'purchase_order.status_changed',
      schemaVersion: 1,
      occurredAt: order.updatedAt,
      actor: { kind: 'user', id: context.actor.id },
      correlationId: order.origin.workflowRunId ?? order.id,
      proposalId: order.id,
      actionHash: deps.digest({
        id: order.id,
        revision: order.revision,
        status: order.status,
      }),
      evidenceRefs: [
        order.id,
        ...Object.values(order.origin).filter(
          (value): value is string => typeof value === 'string',
        ),
      ],
      details: {
        purchaseOrderId: order.id,
        commandId: eventId,
        from: from ?? '',
        to: order.status,
        revision: String(order.revision),
        reason,
      },
    };
  }

  return {
    /** Reads suppliers after refreshing workspace membership. */
    async suppliers(context: TenantContext) {
      context = await authorize(context);
      const items = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.suppliers(),
      );

      return { items, canManage: context.actor.role !== 'member' };
    },
    /** Reads purchase orders after refreshing workspace membership. */
    async orders(context: TenantContext) {
      context = await authorize(context);
      const items = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.orders(),
      );

      return { items, canManage: context.actor.role !== 'member' };
    },
    /** Looks up one tenant supplier without exposing another workspace's records. */
    async supplier(context: TenantContext, id: string) {
      context = await authorize(context);

      return deps.store.transaction(context.tenantId, false, (tx) =>
        tx.supplier(id),
      );
    },
    /** Finds open orders, optionally for one supplier, from authoritative records. */
    async openOrders(context: TenantContext, supplierId?: string) {
      context = await authorize(context);

      return deps.store.transaction(context.tenantId, false, async (tx) =>
        (await tx.orders()).filter(
          (order) =>
            order.status === 'open' &&
            (supplierId === undefined || order.supplierId === supplierId),
        ),
      );
    },
    /** Persists a supplier; exact retries return the original record. */
    async createSupplier(context: TenantContext, input: unknown) {
      context = await authorize(context, true);
      const request = deps.parseSupplier(input);

      return command(
        context,
        request.id,
        { kind: 'supplier', ...request },
        async (tx) => {
          const supplier = {
            ...request,
            tenantId: context.tenantId,
            createdAt: deps.now().toISOString(),
          };
          await tx.insertSupplier(supplier);

          return supplier;
        },
      );
    },
    /** Creates a draft with immutable lines, ownership and origin references. */
    async createOrder(context: TenantContext, input: unknown) {
      context = await authorize(context, true);
      const request = deps.parseOrder(input);
      const problem = purchaseOrderProblem(request);
      if (problem) conflict(problem);

      return command(
        context,
        request.id,
        { kind: 'order', ...request },
        async (tx) => {
          const supplier = await tx.supplier(request.supplierId);
          if (!supplier)
            throw new IdentityError(404, 'NOT_FOUND', 'Supplier not found');
          const now = deps.now().toISOString();
          const order: PurchaseOrder = {
            ...request,
            tenantId: context.tenantId,
            supplierName: supplier.name,
            status: 'draft',
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          await tx.insertOrder(order);
          await tx.audit(
            audit(context, order, request.id, null, 'Purchase order created'),
          );

          return order;
        },
      );
    },
    /** Reads a purchase order and its ordered audit history in one snapshot. */
    async detail(context: TenantContext, id: string) {
      context = await authorize(context);

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const order = await tx.order(id);
        if (!order)
          throw new IdentityError(404, 'NOT_FOUND', 'Purchase order not found');
        const canManage = context.actor.role !== 'member';

        return {
          order,
          history: await tx.history(id),
          canManage,
          allowedTransitions: canManage ? nextStatuses(order) : [],
        };
      });
    },
    /** Applies a revision-checked transition and audit atomically; command retries are idempotent. */
    async transition(context: TenantContext, id: string, input: unknown) {
      context = await authorize(context, true);
      const request = deps.parseTransition(input);

      return command(
        context,
        request.id,
        { kind: 'transition', purchaseOrderId: id, ...request },
        async (tx) => {
          const order = await tx.order(id);
          if (!order)
            throw new IdentityError(
              404,
              'NOT_FOUND',
              'Purchase order not found',
            );
          if (order.revision !== request.expectedRevision)
            conflict(
              'This purchase order changed. Refresh and review its current status.',
            );
          if (!nextStatuses(order).includes(request.status))
            conflict(
              'This status change is not available for this purchase order.',
            );
          const updated = {
            ...order,
            status: request.status,
            revision: order.revision + 1,
            updatedAt: deps.now().toISOString(),
          };
          await tx.updateOrder(updated);
          await tx.audit(
            audit(context, updated, request.id, order.status, request.reason),
          );

          return updated;
        },
      );
    },
  };
}

export type ProcurementService = ReturnType<typeof createProcurementService>;
