/** A return write as the background pass sees it: creation, settlement or exchange step. */
export interface RecoverableReturnWrite {
  state: string;
  /** Settlement and exchange steps hold a durable send fence; creations have none. */
  sent?: boolean;
  decisionId: string | null;
  expiresAt: string;
  updatedAt: string;
}

/**
 * What the background pass does with one return write now.
 * - `decision`: apply an approval or rejection policy recorded but the owner never stored.
 * - `expire`: the approval window passed before anything was sent; record it as expired.
 * - `send`: dispatch the approved write as its requester.
 * - `reconcile`: ask the execution ledger whether it was reserved, then resume or read.
 */
export type ReturnRecoveryStep = 'decision' | 'expire' | 'send' | 'reconcile';

/** How long a write rests before the pass touches it, so it does not race a live request. */
export const returnRecoveryWait = {
  /** An API request is normally still dispatching a write this recent. */
  sending: 2 * 60_000,
  /** Checks of an uncertain write by reading run at most once a minute. */
  uncertain: 60_000,
  /** Pending money is read again at most every five minutes. */
  pending: 5 * 60_000,
} as const;

/** Chooses the background step for one write, or null when it needs nothing now. */
export function returnRecoveryStep(
  value: RecoverableReturnWrite,
  now: Date,
): ReturnRecoveryStep | null {
  const expired = Date.parse(value.expiresAt) <= now.getTime();
  const idle = now.getTime() - Date.parse(value.updatedAt);
  switch (value.state) {
    case 'approval_required':
      return expired ? 'expire' : value.decisionId ? 'decision' : null;
    case 'approved':
      if (value.sent) return 'reconcile';

      return expired ? 'expire' : 'send';
    case 'sending':
      return idle >= returnRecoveryWait.sending ? 'reconcile' : null;
    case 'uncertain':
      return idle >= returnRecoveryWait.uncertain ? 'reconcile' : null;
    case 'pending':
      return idle >= returnRecoveryWait.pending ? 'reconcile' : null;
    default:
      return null;
  }
}
