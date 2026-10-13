import type { PurchaseOrder, PurchaseOrderLine } from './procurement.js';

/** @public Declaration emit names provider identities in the inferred revision service contract. */
export interface SourceReference {
  externalId: string;
  scopeKey: string;
}

/** The independent purchasing read frozen into a proposed revision. */
export interface RevisionSourceOrder {
  supplier: SourceReference;
  orderNumber: string | null;
  lumaOrderId: string | null;
  status:
    | 'open'
    | 'released'
    | 'in_progress'
    | 'partially_delivered'
    | 'overdue'
    | 'completed'
    | 'unknown';
  requestedDeliveryDate: string | null;
  confirmed: boolean | null;
  createdAt: string | null;
  lines: {
    id: SourceReference;
    sku: SourceReference | null;
    itemNumber: string | null;
    quantity: { amount: string; unit: string };
    deliveredQuantity: string | null;
    confirmedQuantity: string | null;
    confirmedDeliveryDate: string | null;
    confirmed: boolean | null;
    requestedDeliveryDate: string | null;
  }[];
}

/** @public Declaration emit names the frozen provider operation in the composed revision service. */
export interface RevisionSourceInput {
  order: SourceReference;
  expected: RevisionSourceOrder;
  operation:
    | {
        kind: 'update_line';
        line: SourceReference;
        quantity?: number | undefined;
        requestedDeliveryDate?: string | undefined;
      }
    | {
        kind: 'add_line';
        sku: SourceReference;
        quantity: number;
        requestedDeliveryDate: string;
      }
    | { kind: 'remove_line'; line: SourceReference };
}

/** One approved source operation produces one independently verified immutable order revision. */
export interface PurchaseOrderChangeInput {
  id: string;
  expectedRevision: number;
  reason: string;
  operation:
    | {
        kind: 'update_line';
        lineId: string;
        quantity?: number | undefined;
        requestedDeliveryDate?: string | undefined;
      }
    | {
        kind: 'add_line';
        line: PurchaseOrderLine;
        requestedDeliveryDate: string;
      }
    | { kind: 'remove_line'; lineId: string }
    | { kind: 'cancel' };
}

export interface PurchaseOrderChange {
  id: string;
  tenantId: string;
  purchaseOrderId: string;
  connectionId: string;
  actionId: string;
  decisionId: string | null;
  request: PurchaseOrderChangeInput;
  requestDigest: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  state:
    | 'preparing'
    | 'approval_required'
    | 'approved'
    | 'rejected'
    | 'submitting'
    | 'uncertain'
    | 'verified'
    | 'failed'
    | 'expired';
  baseline: PurchaseOrder;
  proposed: PurchaseOrder;
  provider: RevisionSourceInput;
  affectsCommitments: boolean;
  decidedBy: string | null;
  verifiedAt: string | null;
  observationRefs: string[];
  failure: string | null;
}

export interface PurchaseOrderRevision {
  order: PurchaseOrder;
  changeId: string | null;
  reason: string;
  recordedBy: string;
  recordedAt: string;
  observationRefs: string[];
}

/** Verifies the entire requested order shape; an added provider ID is resolved by its unique SKU. */
export function matchesPurchaseOrderChange(
  change: PurchaseOrderChange,
  observed: RevisionSourceOrder,
): boolean {
  const { expected, operation } = change.provider;
  if (
    observed.supplier.externalId !== expected.supplier.externalId ||
    observed.supplier.scopeKey !== expected.supplier.scopeKey ||
    observed.lumaOrderId !== change.purchaseOrderId
  )
    return false;
  const desired = expected.lines.map((line) => ({ ...line }));
  if (operation.kind === 'update_line') {
    const line = desired.find(
      (value) => value.id.externalId === operation.line.externalId,
    );
    if (!line) return false;
    if (operation.quantity !== undefined)
      line.quantity = { ...line.quantity, amount: String(operation.quantity) };
    if (operation.requestedDeliveryDate)
      line.requestedDeliveryDate = operation.requestedDeliveryDate;
  } else if (operation.kind === 'remove_line') {
    const index = desired.findIndex(
      (line) => line.id.externalId === operation.line.externalId,
    );
    if (index === -1) return false;
    desired.splice(index, 1);
  } else
    desired.push({
      id: { externalId: '', scopeKey: change.provider.order.externalId },
      sku: operation.sku,
      itemNumber: null,
      quantity: { amount: String(operation.quantity), unit: 'each' },
      deliveredQuantity: '0',
      confirmedQuantity: null,
      confirmedDeliveryDate: null,
      confirmed: null,
      requestedDeliveryDate: operation.requestedDeliveryDate,
    });

  return (
    observed.lines.length === desired.length &&
    desired.every((line) => {
      const matches = observed.lines.filter((value) =>
        line.id.externalId
          ? value.id.externalId === line.id.externalId
          : value.sku?.externalId === line.sku?.externalId &&
            value.sku?.scopeKey === line.sku?.scopeKey,
      );
      const actual = matches[0];

      return (
        matches.length === 1 &&
        !!actual &&
        actual.id.scopeKey === line.id.scopeKey &&
        actual.sku?.externalId === line.sku?.externalId &&
        actual.sku?.scopeKey === line.sku?.scopeKey &&
        Math.abs(
          Number(actual.quantity.amount) - Number(line.quantity.amount),
        ) < 1e-6 &&
        actual.quantity.unit === line.quantity.unit &&
        actual.requestedDeliveryDate === line.requestedDeliveryDate
      );
    })
  );
}
