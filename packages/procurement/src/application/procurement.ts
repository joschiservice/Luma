import type { AuditEntry } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';

import {
  type Commitment,
  defaultSupplierTerms,
  type FollowUp,
  orderProgress,
  type Submission,
} from '../domain/commitments.js';
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
  /** Blocks a lifecycle transition while an admitted source revision is outstanding. */
  pendingOrderChange?(orderId: string): Promise<boolean>;
  /** Prevents local cancellation from claiming a submitted purchasing-system order was cancelled. */
  submittedNativeOrder?(orderId: string): Promise<boolean>;
  /** Resolves current supplier terms for a uniquely mapped SKU code at drafting time. */
  termSnapshots?(
    supplierId: string,
    sku: string,
  ): Promise<{
    unitPrice?: { amount: string; currency: string } | undefined;
    supplierArticleNumber?: string | undefined;
  }>;
  /** Reads current source commitment facts under the same procurement lock as draft creation. */
  shortfallState?(orderId: string): Promise<{
    order: PurchaseOrder;
    commitments: Commitment[];
    followUps: FollowUp[];
    submission: Submission | null;
  } | null>;
  /** Inserts an immutable supplier. */
  insertSupplier(supplier: Supplier): Promise<void>;
  /** Updates supplier contact and its revision in the owner transaction. */
  updateSupplier?(supplier: Supplier): Promise<void>;
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
  parseSupplierContact?:
    | ((input: unknown) => {
        id: string;
        expectedRevision: number;
        email: string | null;
        language: 'en' | 'de' | null;
      })
    | undefined;
  parseOrder(input: unknown): PurchaseOrderInput;
  parseTransition(input: unknown): TransitionInput;
  /** Updates Inventory-owned arrival expectations after an order lifecycle command commits. */
  changed?(context: TenantContext, orderId: string): Promise<void>;
}) {
  async function authorize(context: TenantContext, write = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, write ? 'procurement.manage' : 'procurement.read');
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

      return { items, canManage: hasPermission(context, 'procurement.manage') };
    },
    /** Changes correspondence contact using a revision check, request deduplication and audit. */
    async updateSupplierContact(
      context: TenantContext,
      supplierId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      if (!deps.parseSupplierContact)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Supplier contact editing is unavailable',
        );
      const request = deps.parseSupplierContact(input);

      return command(
        context,
        request.id,
        { kind: 'supplier_contact', supplierId, ...request },
        async (tx) => {
          const supplier = await tx.supplier(supplierId);
          if (!supplier)
            throw new IdentityError(404, 'NOT_FOUND', 'Supplier not found');
          if ((supplier.revision ?? 1) !== request.expectedRevision)
            conflict('This supplier changed. Refresh and review it again.');
          if (!tx.updateSupplier)
            throw new IdentityError(
              503,
              'SERVICE_UNAVAILABLE',
              'Supplier contact editing is unavailable',
            );
          const updated: Supplier = {
            ...supplier,
            email: request.email ?? undefined,
            language: request.language ?? undefined,
            revision: request.expectedRevision + 1,
          };
          await tx.updateSupplier(updated);
          await tx.audit({
            id: deps.id(),
            tenantId: context.tenantId,
            eventKey: `procurement:contact:${request.id}`,
            eventType: 'supplier.contact_updated',
            schemaVersion: 1,
            occurredAt: deps.now().toISOString(),
            actor: { kind: 'user', id: context.actor.id },
            correlationId: context.requestId,
            proposalId: supplierId,
            actionHash: deps.digest(request),
            evidenceRefs: [supplierId],
            details: {
              supplierId,
              revision: String(updated.revision),
              language: request.language ?? '',
              hasEmail: String(!!request.email),
            },
          });

          return updated;
        },
      );
    },
    /** Reads purchase orders after refreshing workspace membership. */
    async orders(context: TenantContext) {
      context = await authorize(context);
      const items = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.orders(),
      );

      return { items, canManage: hasPermission(context, 'procurement.manage') };
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
    /** Creates a draft with immutable provenance; workflow callers can atomically exclude existing SKU commitments. */
    async createOrder(
      context: TenantContext,
      input: unknown,
      options: { preventDuplicateSku?: boolean } = {},
    ) {
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
          if (request.origin.sourcePurchaseOrderId) {
            const source = await tx.shortfallState?.(
              request.origin.sourcePurchaseOrderId,
            );
            if (
              !source ||
              !request.origin.sourceAttentionKey ||
              source.order.supplierId === request.supplierId
            )
              conflict(
                'Review the source shortfall and choose another supplier.',
              );
            const progress = orderProgress({
              ...source,
              terms: defaultSupplierTerms,
              draftVerified: false,
              supplierLinked: false,
              now: deps.now(),
            });
            if (
              !progress.attention.some(
                (attention) =>
                  attention.key === request.origin.sourceAttentionKey &&
                  ['commitment_changed', 'receipt_difference'].includes(
                    attention.kind,
                  ),
              )
            )
              conflict(
                'This difference already has a decision. Refresh the source order.',
              );
          }
          // Serialize the final duplicate check with creation, including other stock positions.
          if (
            options.preventDuplicateSku &&
            (await tx.orders()).some(
              (order) =>
                order.id !== request.origin.sourcePurchaseOrderId &&
                ['draft', 'open'].includes(order.status) &&
                order.lines.some((line) =>
                  request.lines.some((proposed) => proposed.sku === line.sku),
                ),
            )
          )
            conflict(
              'An existing draft or open purchase order already covers this SKU.',
            );
          const lines = await Promise.all(
            request.lines.map(async (line) => ({
              ...(!request.origin.actionId &&
              !request.origin.workflowRunId &&
              !request.origin.outcomeId
                ? ((await tx.termSnapshots?.(request.supplierId, line.sku)) ??
                  {})
                : {}),
              ...line,
            })),
          );
          const now = deps.now().toISOString();
          const order: PurchaseOrder = {
            ...request,
            lines,
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
        const canManage = hasPermission(context, 'procurement.manage');
        const nativeSubmitted = !!(await tx.submittedNativeOrder?.(id));

        return {
          order,
          history: await tx.history(id),
          canManage,
          allowedTransitions:
            canManage && !(await tx.pendingOrderChange?.(id))
              ? nextStatuses(order).filter(
                  (status) => status !== 'cancelled' || !nativeSubmitted,
                )
              : [],
        };
      });
    },
    /** Applies a revision-checked transition and audit atomically; command retries are idempotent. */
    async transition(context: TenantContext, id: string, input: unknown) {
      context = await authorize(context, true);
      const request = deps.parseTransition(input);

      const result = await command(
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
          if (
            request.status === 'cancelled' &&
            (await tx.submittedNativeOrder?.(id))
          )
            conflict(
              'Submitted purchasing-system orders require verified source cancellation. This connection does not support cancellation.',
            );
          if (await tx.pendingOrderChange?.(id))
            conflict(
              'An order change still needs approval or verification. Resolve it before changing the order lifecycle.',
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
      await deps.changed?.(context, id);

      return result;
    },
  };
}

export type ProcurementService = ReturnType<typeof createProcurementService>;
