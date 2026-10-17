import type { AuditEntry } from '@luma/audit';
import type { ExternalId } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import { conflict, forbidden } from '@luma/platform';

import type {
  Commitment,
  FollowUp,
  OrderProgress,
  Submission,
} from '../domain/commitments.js';
import { defaultSupplierTerms, orderProgress } from '../domain/commitments.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import type {
  CommitmentDependencies,
  CommitmentTransaction,
} from './commitments.js';

/** One hour in milliseconds. */
export const hour = 3_600_000;

// Activity shows `reason` as the event summary.
const auditSummaries: Record<string, string> = {
  'purchase_order.submission_requested':
    'Approval requested to send to the supplier',
  'purchase_order.submission_approved': 'Sending to the supplier approved',
  'purchase_order.submission_rejected': 'Sending to the supplier rejected',
  'purchase_order.submitted': 'Placed in the purchasing system and verified',
  'purchase_order.message_recorded': 'Supplier message recorded',
  'purchase_order.message_read': 'Supplier message read',
  'purchase_order.message_removed': 'Supplier message text removed',
  'purchase_order.commitment_recorded': 'Supplier commitment recorded',
  'purchase_order.commitment_reviewed': 'Supplier commitment reviewed',
  'purchase_order.follow_up': 'Supplier follow-up recorded',
  'supplier.updated': 'Supplier purchasing link updated',
};

/** Records of one or more orders that their progress is computed from. */
interface ProgressRecords {
  submissions: Submission[];
  commitments: Commitment[];
  followUps: FollowUp[];
  supplier: Supplier | null;
  /** Workflow run IDs whose drafts replenishment independently verified. */
  verified: Set<string>;
  /** Evaluation time; defaults to now. */
  now?: Date;
}

/**
 * Collaborators and helpers shared by the supplier commitment use cases. Every helper that takes
 * a transaction runs inside the caller's procurement transaction and opens none of its own.
 */
export interface CommitmentContext {
  deps: CommitmentDependencies;
  /**
   * Re-reads the caller's workspace membership and requires `procurement.read`, or
   * `procurement.manage` with `write`. Throws 403 when the refreshed actor is someone else.
   */
  authorize(context: TenantContext, write?: boolean): Promise<TenantContext>;
  /**
   * Builds a procurement audit entry. Its ID and event key derive from `type` and `eventId`,
   * so a replayed write records the same entry.
   */
  audit(
    context: TenantContext,
    type: string,
    eventId: string,
    orderId: string,
    details: Record<string, string>,
    evidenceRefs?: string[],
  ): AuditEntry;
  /**
   * Runs a write once per command ID in one procurement transaction; an exact retry returns the
   * original result and another request with the same ID throws 409.
   */
  command<T>(
    context: TenantContext,
    id: string,
    request: unknown,
    operation: (tx: CommitmentTransaction) => Promise<T>,
  ): Promise<T>;
  /** Reads the suppliers of `orders` in one query, keyed by ID; unknown suppliers are absent. */
  suppliersOf(
    tx: CommitmentTransaction,
    orders: PurchaseOrder[],
  ): Promise<Map<string, Supplier>>;
  /** The supplier's follow-up terms, with defaults for unset values. */
  terms(supplier: Supplier | null): { confirmationHours: number };
  /** The order's latest submission and its progress from `data`. */
  progressFor(
    order: PurchaseOrder,
    data: ProgressRecords,
  ): { progress: OrderProgress; submission: Submission | null };
  /** The order's lines with their purchasing-system SKU on `connectionId`, or null when unlinked. */
  lineMapping(
    tx: CommitmentTransaction,
    order: PurchaseOrder,
    connectionId: string,
  ): Promise<
    { line: PurchaseOrder['lines'][number]; sku: ExternalId | null }[]
  >;
  /** Saves `patch` with a fresh `updatedAt`; a settled submission leaves background checks. */
  saveSubmission(
    tx: CommitmentTransaction,
    submission: Submission,
    patch: Partial<Submission>,
    settled?: boolean,
  ): Promise<Submission>;
  /** Awaits a procurement write, then projects the order's expected arrivals through Inventory. */
  incomingResult<T>(
    context: TenantContext,
    orderId: string,
    result: Promise<T>,
  ): Promise<T>;
}

/** Builds the shared context of the supplier commitment use cases from their dependencies. */
export function createCommitmentContext(
  deps: CommitmentDependencies,
): CommitmentContext {
  async function authorize(context: TenantContext, write = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, write ? 'procurement.manage' : 'procurement.read');
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');

    return fresh;
  }

  function audit(
    context: TenantContext,
    type: string,
    eventId: string,
    orderId: string,
    details: Record<string, string>,
    evidenceRefs: string[] = [],
  ): AuditEntry {
    return {
      id: deps.uuid(`audit:${type}:${eventId}`),
      tenantId: context.tenantId,
      eventKey: `procurement:${type}:${eventId}`,
      eventType: type,
      schemaVersion: 1,
      occurredAt: deps.now().toISOString(),
      actor: { kind: 'user', id: context.actor.id },
      correlationId: orderId,
      proposalId: orderId,
      actionHash: deps.digest({ type, eventId, details }),
      evidenceRefs: [orderId, ...evidenceRefs],
      details: {
        ...(type.startsWith('purchase_order.')
          ? { purchaseOrderId: orderId }
          : {}),
        reason: auditSummaries[type] ?? type,
        ...details,
      },
    };
  }

  /** Runs a write once per command ID; an exact retry returns the original result. */
  async function command<T>(
    context: TenantContext,
    id: string,
    request: unknown,
    operation: (tx: CommitmentTransaction) => Promise<T>,
  ): Promise<T> {
    const digest = deps.digest({ actorId: context.actor.id, request });

    return deps.store.transaction(context.tenantId, true, async (tx) => {
      const prior = await tx.command(id);
      if (prior) {
        if (prior.digest !== digest)
          throw conflict(
            'This request ID was already used. Refresh before trying again.',
          );

        return prior.result as T;
      }
      const result = await operation(tx);
      await tx.saveCommand(id, digest, result);

      return result;
    });
  }

  async function suppliersOf(
    tx: CommitmentTransaction,
    orders: PurchaseOrder[],
  ) {
    const ids = [...new Set(orders.map((o) => o.supplierId))];

    return new Map(
      (ids.length ? await tx.suppliers(ids) : []).map(
        (supplier) => [supplier.id, supplier] as const,
      ),
    );
  }

  const terms = (supplier: Supplier | null) => ({
    confirmationHours:
      supplier?.confirmationHours ?? defaultSupplierTerms.confirmationHours,
  });

  function progressFor(
    order: PurchaseOrder,
    data: ProgressRecords,
  ): { progress: OrderProgress; submission: Submission | null } {
    const submission =
      data.submissions.find((s) => s.purchaseOrderId === order.id) ?? null;

    return {
      submission,
      progress: orderProgress({
        order,
        submission,
        commitments: data.commitments.filter(
          (c) => c.purchaseOrderId === order.id,
        ),
        followUps: data.followUps.filter((f) => f.purchaseOrderId === order.id),
        terms: terms(data.supplier),
        draftVerified:
          !!order.origin.workflowRunId &&
          data.verified.has(order.origin.workflowRunId),
        supplierLinked: !!data.supplier?.link,
        now: data.now ?? deps.now(),
      }),
    };
  }

  async function lineMapping(
    tx: CommitmentTransaction,
    order: PurchaseOrder,
    connectionId: string,
  ) {
    const identities = await tx.skuIdentities(
      connectionId,
      order.lines.map((line) => line.sku),
    );

    return order.lines.map((line) => ({
      line,
      sku: identities.get(line.sku) ?? null,
    }));
  }

  async function saveSubmission(
    tx: CommitmentTransaction,
    submission: Submission,
    patch: Partial<Submission>,
    settled = false,
  ) {
    const next = {
      ...submission,
      ...patch,
      updatedAt: deps.now().toISOString(),
    };
    await tx.saveSubmission(next, settled);

    return next;
  }

  async function incomingResult<T>(
    context: TenantContext,
    orderId: string,
    result: Promise<T>,
  ): Promise<T> {
    const value = await result;
    await deps.incomingChanged?.(context, orderId);

    return value;
  }

  return {
    deps,
    authorize,
    audit,
    command,
    suppliersOf,
    terms,
    progressFor,
    lineMapping,
    saveSubmission,
    incomingResult,
  };
}
