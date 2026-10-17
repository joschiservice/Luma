import { createHash, randomUUID } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import {
  type CommitmentDependencies,
  createSupplierCommitments,
} from './application/commitments.js';
import { createIncomingStock as assembleIncomingStock } from './application/incoming.js';
import { createProcurementService } from './application/procurement.js';
import { createPurchaseOrderChangeService } from './application/purchase-order-changes.js';
import { createPurchasingService } from './application/purchasing.js';
import { createPurchasingOutcomes } from './application/purchasing-outcomes.js';
import { createSupplierEmail } from './application/supplier-email.js';
import { createSupplierTermsService } from './application/supplier-terms.js';
import type { PurchasingObservation } from './domain/commitments.js';
import { createCommitmentStore } from './infrastructure/commitment-store.js';
import { extractionOutput } from './infrastructure/extraction-schema.js';
import { incomingStockQuerySchema } from './infrastructure/incoming-stock-validation.js';
import { createPurchaseOrderChangeStore } from './infrastructure/purchase-order-changes-store.js';
import { purchaseOrderChangeInputSchema } from './infrastructure/purchase-order-changes-validation.js';
import { purchaseOrderPdf } from './infrastructure/purchase-order-pdf.js';
import { createPurchasingInputs } from './infrastructure/purchasing-inputs.js';
import { purchasingIgnoreSchema } from './infrastructure/purchasing-outcomes-validation.js';
import { createPurchasingOverview } from './infrastructure/purchasing-overview.js';
import { createPurchasingStore } from './infrastructure/purchasing-store.js';
import {
  purchasingPlanInputSchema,
  purchasingSettingsSchema,
} from './infrastructure/purchasing-validation.js';
import { createProcurementStore } from './infrastructure/store.js';
import {
  supplierContactInputSchema,
  supplierEmailInputSchema,
  supplierFollowUpInputSchema,
} from './infrastructure/supplier-email-validation.js';
import { createSupplierTermsStore } from './infrastructure/supplier-terms-store.js';
import { supplierTermsInputSchema } from './infrastructure/supplier-terms-validation.js';
import {
  commitmentInputSchema,
  followUpInputSchema,
  messageInputSchema,
  purchaseOrderInputSchema,
  receiptInputSchema,
  reviewInputSchema,
  submissionDecisionSchema,
  submissionInputSchema,
  supplierInputSchema,
  supplierLinkInputSchema,
  transitionInputSchema,
} from './infrastructure/validation.js';

export { createProcurementCapabilities } from './infrastructure/capabilities.js';

/** Composes authoritative procurement storage with refreshed membership and transactional audit. */
export function createProcurement(
  db: TenantDatabase,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  audit: (db: TenantDatabase) => AuditLog,
  changed?: (context: TenantContext, orderId: string) => Promise<void>,
) {
  return createProcurementService({
    store: createProcurementStore(db, audit),
    ...(changed ? { changed } : {}),
    parseSupplier: (input) => supplierInputSchema.parse(input),
    parseSupplierContact: (input) => supplierContactInputSchema.parse(input),
    parseOrder: (input) => purchaseOrderInputSchema.parse(input),
    parseTransition: (input) => transitionInputSchema.parse(input),
    refreshContext,
    now: () => new Date(),
    id: randomUUID,
    digest: (value) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  });
}

export { createReplenishmentStore } from './infrastructure/replenishment-store.js';

export { createReplenishmentReviewContext } from './infrastructure/replenishment-review-context.js';

export {
  createProcurementMetricReader,
  createStockRiskReader,
} from './infrastructure/metrics.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Derives a stable UUID (version 5 layout) from a name. */
function nameUuid(name: string) {
  const hex = createHash('sha256')
    .update(`luma:procurement:${name}`)
    .digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Composes the supplier lifecycle with procurement storage. Without purchasing connections or
 * execution, reads and message capture still work and sending reports why it is unavailable.
 */
export function createSupplierCommitmentService(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
  deps: Pick<
    CommitmentDependencies,
    | 'purchasing'
    | 'admission'
    | 'refreshContext'
    | 'principal'
    | 'openOrder'
    | 'trace'
    | 'reconciliationAvailable'
    | 'shortfallAvailable'
    | 'incomingChanged'
    | 'additionalTimeline'
    | 'timelineActors'
  > & {
    /** Supplier-message extraction; a missing `reason` explains that it isn't set up. */
    model: Omit<CommitmentDependencies['model'], 'output' | 'reason'> & {
      reason: string | null;
    };
    retentionDays?: number;
    /** Publishes newly persisted provider observations atomically with procurement storage. */
    observed?: (
      db: TenantDatabase,
      observation: PurchasingObservation,
    ) => Promise<void>;
  },
) {
  return createSupplierCommitments({
    ...deps,
    model: {
      ...deps.model,
      reason:
        deps.model.reason ??
        'Automatic extraction of supplier commitments isn’t set up on this server. Connected mailbox messages are still available in Inbox.',
      output: extractionOutput,
    },
    store: createCommitmentStore(db, audit, deps.observed),
    verifiedDrafts: (context, runIds) =>
      db.transaction(
        context.tenantId,
        async (tx) =>
          new Set(
            (
              await tx.query<{ run_id: string }>(
                `SELECT DISTINCT run_id FROM workflow_process_steps WHERE tenant_id=$1
               AND run_id=ANY($2::uuid[]) AND step_id='verify-order' AND state='completed'`,
                [context.tenantId, runIds],
              )
            ).rows.map((r) => r.run_id),
          ),
      ),
    retentionDays: deps.retentionDays ?? 365,
    digest,
    id: randomUUID,
    uuid: nameUuid,
    now: () => new Date(),
    parse: {
      link: (input) => supplierLinkInputSchema.parse(input),
      submission: (input) => submissionInputSchema.parse(input),
      decision: (input) => submissionDecisionSchema.parse(input),
      message: (input) => messageInputSchema.parse(input),
      commitment: (input) => commitmentInputSchema.parse(input),
      receipt: (input) => receiptInputSchema.parse(input),
      review: (input) => reviewInputSchema.parse(input),
      followUp: (input) => followUpInputSchema.parse(input),
    },
  });
}

export type {
  PurchasingOrder,
  PurchasingSystem,
  SubmissionAdmission,
  SubmissionExecution,
  SupplierCommitments,
} from './application/commitments.js';

export { supplierExtractionProfile } from './application/extraction.js';

export {
  createPurchasingStore,
  createPurchasingInputs,
  createPurchasingOverview,
};

/** Supplies owner validation independently of the HTTP contract. */
export function createPurchasing(
  deps: Omit<
    Parameters<typeof createPurchasingService>[0],
    'parsePlan' | 'parseSettings'
  >,
) {
  return createPurchasingService({
    ...deps,
    parsePlan: (input) => purchasingPlanInputSchema.parse(input),
    parseSettings: (input) => purchasingSettingsSchema.parse(input),
  });
}

export type { PurchasingAdmission } from './application/purchasing.js';

export { createShortfallAcknowledgement } from './application/shortfall-acknowledgement.js';

/** Composes validation for recorded recommendation decisions. */
export function createPurchasingOutcomesService(
  deps: Omit<Parameters<typeof createPurchasingOutcomes>[0], 'parse'>,
) {
  return createPurchasingOutcomes({
    ...deps,
    parse: (input) => purchasingIgnoreSchema.parse(input),
  });
}

export { createPurchasingOutcomePersistence } from './infrastructure/purchasing-outcomes.js';

/** Composes append-only terms with authorization, release control and transactional audit. */
export function createSupplierTerms(
  db: TenantDatabase,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  audit: (db: TenantDatabase) => AuditLog,
  released: (context: TenantContext) => Promise<boolean>,
) {
  return createSupplierTermsService({
    store: createSupplierTermsStore(db, audit),
    refreshContext,
    released,
    parse: (input) => supplierTermsInputSchema.parse(input),
    digest,
    id: randomUUID,
    now: () => new Date(),
  });
}

export type { SupplierEmail } from './application/supplier-email.js';

/** Composes tenant-scoped arrivals with bounded canonical identity validation. */
export function createIncomingStock(
  deps: Omit<Parameters<typeof assembleIncomingStock>[0], 'parse'>,
) {
  return assembleIncomingStock({
    ...deps,
    parse: (input) => incomingStockQuerySchema.parse(input),
  });
}

export { createIncomingStockReader } from './infrastructure/incoming-stock.js';

/** Composes supplier work over the existing inbox's persistence, admission and verification. */
export function createSupplierEmailService(
  deps: Omit<
    Parameters<typeof createSupplierEmail>[0],
    'parseSubmission' | 'parseFollowUp' | 'pdf'
  >,
) {
  return createSupplierEmail({
    ...deps,
    pdf: purchaseOrderPdf,
    parseSubmission: (input) => supplierEmailInputSchema.parse(input),
    parseFollowUp: (input) => supplierFollowUpInputSchema.parse(input),
  });
}

/** Composes one-operation source revisions with immutable snapshots and transactional audit. */
export function createPurchaseOrderChanges(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
  deps: Omit<
    Parameters<typeof createPurchaseOrderChangeService>[0],
    'store' | 'parse' | 'digest' | 'uuid' | 'now'
  >,
) {
  return createPurchaseOrderChangeService({
    ...deps,
    store: createPurchaseOrderChangeStore(db, audit),
    parse: (input) => purchaseOrderChangeInputSchema.parse(input),
    digest,
    uuid: nameUuid,
    now: () => new Date(),
  });
}

export { createFollowUpPlanStore } from './infrastructure/governed-follow-up.js';

export { createPurchasingTimelineActors } from './infrastructure/timeline-actors.js';

export { createPurchasingTermsImporter } from './infrastructure/purchasing-terms-import.js';

export { createReplenishmentApprovalCoverage } from './infrastructure/replenishment-approval-coverage.js';

export {
  listReplenishmentScopes,
  listSubmissionScopes,
  purgeExpiredSupplierMessages,
} from './infrastructure/background-scopes.js';

export {
  purchaseOrderCitations,
  purchaseOrderEvidence,
  purchaseOrderMessageRefs,
  purchaseOrderStockRefs,
  purchasingPlanCitations,
  purchasingPlanEvidence,
} from './infrastructure/purchase-order-evidence.js';

export {
  replenishmentRunCitations,
  replenishmentRunEvidence,
} from './infrastructure/replenishment-evidence.js';
