/** Minimal SQL port for identity-owned support commands, within the caller's transaction. */
export interface IdentitySupportTransaction {
  query<T extends Record<string, unknown>>(
    sql: string,
    values: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface SupportSessionRevocation {
  commandId: string;
  revokedSessions: number;
  completedAt: string;
}

/** Executes the narrowly granted identity function; authorization, receipt and session deletion commit atomically. */
export async function revokeCustomerSessionsForSupport(
  tx: IdentitySupportTransaction,
  input: {
    commandId: string;
    workspaceId: string;
    userId: string;
    reason: string;
    requestId: string;
  },
): Promise<SupportSessionRevocation> {
  const result = await tx.query<{ receipt: SupportSessionRevocation }>(
    'SELECT identity_support_revoke_sessions($1,$2,$3,$4,$5) AS receipt',
    [
      input.commandId,
      input.workspaceId,
      input.userId,
      input.reason,
      input.requestId,
    ],
  );
  const receipt = result.rows[0]?.receipt;
  if (!receipt) throw new Error('Support command returned no receipt.');

  return {
    ...receipt,
    completedAt: new Date(receipt.completedAt).toISOString(),
  };
}

export interface SupportMembershipChange {
  commandId: string;
  membershipId: string;
  status: 'active' | 'suspended';
  /** Whether the suspension left the workspace without an active owner. */
  lastActiveOwner: boolean;
  completedAt: string;
}

/**
 * Suspends or reactivates one membership through the narrowly granted identity function. The
 * membership change, receipt, customer access event and staff audit commit atomically in the
 * caller's transaction. Suspending the only active owner needs `acknowledgeLastOwner`.
 * PostgreSQL errors carry the codes documented on `identity_support_change_membership`.
 */
export async function changeMembershipForSupport(
  tx: IdentitySupportTransaction,
  input: {
    commandId: string;
    workspaceId: string;
    userId: string;
    action: 'suspend' | 'reactivate';
    reason: string;
    acknowledgeLastOwner: boolean;
    requestId: string;
  },
): Promise<SupportMembershipChange> {
  const result = await tx.query<{ receipt: SupportMembershipChange }>(
    'SELECT identity_support_change_membership($1,$2,$3,$4,$5,$6,$7) AS receipt',
    [
      input.commandId,
      input.workspaceId,
      input.userId,
      input.action,
      input.reason,
      input.acknowledgeLastOwner,
      input.requestId,
    ],
  );
  const receipt = result.rows[0]?.receipt;
  if (!receipt) throw new Error('Support command returned no receipt.');

  return {
    ...receipt,
    completedAt: new Date(receipt.completedAt).toISOString(),
  };
}

/** Why staff disabled an account; recorded for staff, never shown to the customer. */
export type AccountDisableCategory =
  'compromised' | 'abuse' | 'fraud' | 'legal_request' | 'other';

export interface SupportAccountChange {
  commandId: string;
  status: 'disabled' | 'enabled';
  /** Sessions deleted by disabling; enabling deletes none. */
  revokedSessions: number;
  completedAt: string;
}

/**
 * Disables or enables one customer account through the narrowly granted identity function.
 * Disabling deletes every session of the account; the disablement, receipt, security event and
 * staff audit commit atomically in the caller's transaction. Memberships are untouched, so
 * enabling restores every previous workspace. PostgreSQL errors carry the codes documented on
 * `identity_support_change_account`.
 */
export async function changeAccountForSupport(
  tx: IdentitySupportTransaction,
  input: {
    commandId: string;
    userId: string;
    reason: string;
    requestId: string;
  } & (
    | { action: 'disable'; category: AccountDisableCategory }
    | { action: 'enable' }
  ),
): Promise<SupportAccountChange> {
  const result = await tx.query<{ receipt: SupportAccountChange }>(
    'SELECT identity_support_change_account($1,$2,$3,$4,$5,$6) AS receipt',
    [
      input.commandId,
      input.userId,
      input.action,
      input.action === 'disable' ? input.category : null,
      input.reason,
      input.requestId,
    ],
  );
  const receipt = result.rows[0]?.receipt;
  if (!receipt) throw new Error('Support command returned no receipt.');

  return {
    ...receipt,
    completedAt: new Date(receipt.completedAt).toISOString(),
  };
}

/** Why staff scheduled an account for deletion; recorded with the erasure receipt. */
export type AccountDeletionCategory =
  'customer_request' | 'gdpr_erasure' | 'abuse' | 'inactivity';

export interface SupportAccountDeletion {
  commandId: string;
  deletionId: string;
  /** `erasing`: erasure was requested without the restore window and can't be restored. */
  status: 'scheduled' | 'restored' | 'erasing';
  /** When the erasure pass erases the account. */
  eraseAfter: string;
  /** Sessions ended by this command. */
  revokedSessions: number;
  completedAt: string;
}

/** A deletion command for one account, with the request reference it fulfils. */
export type AccountDeletionCommand =
  | {
      action: 'schedule';
      category: AccountDeletionCategory;
      reference: string;
    }
  | { action: 'restore' }
  | { action: 'erase_now'; reference: string };

/**
 * Schedules, restores or immediately erases one customer account through the narrowly granted
 * deletion functions. Scheduling disables the account, ends its sessions and suspends its active
 * memberships for 30 days; restoring undoes exactly that; erasing now skips the window. The
 * change, receipt, staff audit, security event and notice commit atomically in the caller's
 * transaction. PostgreSQL errors carry the codes documented on the functions.
 */
export async function changeAccountDeletionForSupport(
  tx: IdentitySupportTransaction,
  input: {
    commandId: string;
    userId: string;
    reason: string;
    requestId: string;
  } & AccountDeletionCommand,
): Promise<SupportAccountDeletion> {
  const result = await tx.query<{ receipt: SupportAccountDeletion }>(
    input.action === 'schedule'
      ? 'SELECT identity_support_schedule_account_deletion($1,$2,$3,$4,$5,$6) AS receipt'
      : input.action === 'restore'
        ? 'SELECT identity_support_restore_account($1,$2,$3,$4) AS receipt'
        : 'SELECT identity_support_erase_account_now($1,$2,$3,$4,$5) AS receipt',
    input.action === 'schedule'
      ? [
          input.commandId,
          input.userId,
          input.category,
          input.reference,
          input.reason,
          input.requestId,
        ]
      : input.action === 'restore'
        ? [input.commandId, input.userId, input.reason, input.requestId]
        : [
            input.commandId,
            input.userId,
            input.reference,
            input.reason,
            input.requestId,
          ],
  );
  const receipt = result.rows[0]?.receipt;
  if (!receipt) throw new Error('Support command returned no receipt.');

  return {
    ...receipt,
    eraseAfter: new Date(receipt.eraseAfter).toISOString(),
    completedAt: new Date(receipt.completedAt).toISOString(),
  };
}
