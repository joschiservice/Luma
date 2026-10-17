import type { SupplierOrderSnapshot } from '@luma/connections';

import type { PurchasingOrder } from './commitments.js';

/**
 * A purchasing-system read that procurement cites as evidence for a submission or an order
 * revision. Its ID is the read's observation ID, so verification results, audit entries and
 * revisions that cite it resolve to this record.
 */
export interface PurchasingReadEvidence {
  id: string;
  tenantId: string;
  purchaseOrderId: string;
  /** What the read was cited for, and the submission or order change it belongs to. */
  purpose: 'submission' | 'revision';
  subjectId: string;
  source: {
    provider: string;
    connectionId: string;
    resource: 'purchase_order';
    externalId: string;
    scopeKey: string;
  };
  /** When the read started, on Luma's clock. */
  observedAt: string;
  sourceUpdatedAt: string | null;
  sourceRevision: string | null;
  adapterVersion: string;
  /** A partial read cannot rule out other matching orders. */
  completeness: 'complete' | 'partial';
  data: SupplierOrderSnapshot;
}

/** Builds the stored evidence for one purchasing-system read of a tenant's order. */
export function purchasingReadEvidence(
  tenantId: string,
  connectionId: string,
  purchaseOrderId: string,
  subject: { purpose: PurchasingReadEvidence['purpose']; id: string },
  read: PurchasingOrder,
): PurchasingReadEvidence {
  return {
    id: read.observationId,
    tenantId,
    purchaseOrderId,
    purpose: subject.purpose,
    subjectId: subject.id,
    source: {
      provider: read.provider,
      connectionId,
      resource: 'purchase_order',
      externalId: read.externalId,
      scopeKey: read.scopeKey,
    },
    observedAt: read.observedAt,
    sourceUpdatedAt: read.sourceUpdatedAt,
    sourceRevision: read.sourceRevision,
    adapterVersion: read.adapterVersion,
    completeness: read.completeness,
    data: read.data,
  };
}
