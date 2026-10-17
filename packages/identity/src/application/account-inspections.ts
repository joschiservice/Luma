import type { SupportInspection } from '../domain/settings.js';

/** How an answer or revocation ended: applied now, already in that state, or not possible. */
export type InspectionChange = 'changed' | 'unchanged' | 'conflict';

/**
 * Luma support requests to inspect one person's account, and their answers. The account comes
 * from the caller's session; each change is recorded in the person's security events by the
 * database in the same transaction.
 */
export interface AccountInspections {
  /** Lists pending requests and approved access that is still open, newest first. */
  list(userId: string): Promise<SupportInspection[]>;
  /**
   * Answers a pending, unlapsed request. `unchanged` when the person already gave the same
   * answer, so a retry is safe.
   */
  decide(
    userId: string,
    requestId: string,
    status: 'approved' | 'declined',
    httpRequestId: string,
  ): Promise<InspectionChange>;
  /** Ends approved consented access that is still open; `unchanged` when already revoked. */
  revoke(
    userId: string,
    requestId: string,
    httpRequestId: string,
  ): Promise<InspectionChange>;
}
