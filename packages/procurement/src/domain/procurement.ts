/** @public Declaration emit names it in the inferred type of `createProcurement`. */
export interface ExternalReference {
  system: string;
  externalId: string;
  connectionId?: string | undefined;
}

export interface SupplierInput {
  id: string;
  name: string;
  email?: string | undefined;
  language?: 'en' | 'de' | undefined;
  externalReferences: ExternalReference[];
}

export interface Supplier extends SupplierInput {
  tenantId: string;
  createdAt: string;
  /** Increments with each link or terms change; absent on suppliers created before links existed. */
  revision?: number | undefined;
  /** The supplier's record in a purchasing system Luma can submit orders through. */
  link?: SupplierLink | null | undefined;
  /** Hours after submission by which the supplier should confirm. */
  confirmationHours?: number | undefined;
}

interface SupplierLink {
  connectionId: string;
  externalId: string;
  scopeKey: string;
  /** Name in the purchasing system when linked; descriptive only. */
  name: string | null;
  linkedBy: string;
  linkedAt: string;
}

export interface SupplierLinkInput {
  expectedRevision: number;
  link: { connectionId: string; externalId: string; scopeKey: string } | null;
  confirmationHours: number;
}

export interface PurchaseOrderLine {
  id: string;
  sku: string;
  description: string;
  quantity: number;
  unit: string;
  requestedDeliveryDate?: string | undefined;
  /** Explicit receiving location; absent means the destination is still unknown. */
  locationId?: string | undefined;
  unitPrice?: { amount: string; currency: string } | undefined;
  supplierArticleNumber?: string | undefined;
}

export interface PurchaseOrderInput {
  id: string;
  supplierId: string;
  reference: string;
  authority: 'luma' | 'external';
  externalReferences: ExternalReference[];
  origin: {
    workflowRunId?: string | undefined;
    actionId?: string | undefined;
    outcomeId?: string | undefined;
    /** Source shortfall whose remainder this governed order covers. */
    sourcePurchaseOrderId?: string | undefined;
    sourceAttentionKey?: string | undefined;
  };
  lines: PurchaseOrderLine[];
}

export type PurchaseOrderStatus = 'draft' | 'open' | 'closed' | 'cancelled';

export interface PurchaseOrder extends PurchaseOrderInput {
  tenantId: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransitionInput {
  id: string;
  expectedRevision: number;
  status: PurchaseOrderStatus;
  reason: string;
}

/** Lists the next business states; terminal orders cannot be reopened. */
export function nextStatuses(
  order: Pick<PurchaseOrder, 'authority' | 'status'>,
): PurchaseOrderStatus[] {
  if (order.authority !== 'luma') return [];
  if (order.status === 'draft') return ['open', 'cancelled'];
  if (order.status === 'open') return ['closed', 'cancelled'];

  return [];
}

/** Validates lines and provenance beyond field-level input validation. */
export function purchaseOrderProblem(order: PurchaseOrderInput): string | null {
  if (new Set(order.lines.map((line) => line.id)).size !== order.lines.length)
    return 'Each purchase order line must have a distinct ID.';
  if (order.authority === 'external' && !order.externalReferences.length)
    return 'An externally owned order needs an external reference.';

  return null;
}
