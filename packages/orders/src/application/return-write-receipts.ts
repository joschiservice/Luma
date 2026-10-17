import type { WriteAcceptance, WriteReceiptEvidence } from '@luma/connections';
import { writeReceiptEvidence } from '@luma/connections';

/** The return write a stored receipt belongs to. */
export type ReturnWritePurpose = 'creation' | 'settlement' | 'exchange';

/**
 * The receipt of a provider write orders dispatched for a return case. Its ID is the reference
 * the execution attempt and its audit entry cite; it is stored beside the case's cited reads.
 */
export interface ReturnWriteReceipt extends WriteReceiptEvidence {
  tenantId: string;
  caseId: string;
  purpose: ReturnWritePurpose;
  /** The creation, settlement or exchange step whose write was accepted. */
  subjectId: string;
}

/** Builds the stored receipt for one accepted return write under the given ID. */
export function returnWriteReceipt(
  tenantId: string,
  caseId: string,
  subject: { purpose: ReturnWritePurpose; id: string },
  id: string,
  acceptance: WriteAcceptance,
): ReturnWriteReceipt {
  return {
    ...writeReceiptEvidence(id, acceptance),
    tenantId,
    caseId,
    purpose: subject.purpose,
    subjectId: subject.id,
  };
}

/** The receipt ID for one execution attempt; a repeated store names the same receipt. */
export function returnWriteReceiptName(
  tenantId: string,
  acceptance: WriteAcceptance,
) {
  return `write-receipt:${tenantId}:${acceptance.idempotencyKey}`;
}
