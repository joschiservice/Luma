import { createHash, randomUUID } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import {
  type CommitmentDependencies,
  createSupplierCommitments,
} from './application/commitments.js';
import { createProcurementService } from './application/procurement.js';
import type { PurchasingObservation } from './domain/commitments.js';
import { createCommitmentStore } from './infrastructure/commitment-store.js';
import { extractionOutput } from './infrastructure/extraction-schema.js';
import { createProcurementStore } from './infrastructure/store.js';
import {
  commitmentInputSchema,
  followUpInputSchema,
  messageInputSchema,
  purchaseOrderInputSchema,
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
) {
  return createProcurementService({
    store: createProcurementStore(db, audit),
    parseSupplier: (input) => supplierInputSchema.parse(input),
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
  > & {
    model: Omit<CommitmentDependencies['model'], 'output'>;
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
    model: { ...deps.model, output: extractionOutput },
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
