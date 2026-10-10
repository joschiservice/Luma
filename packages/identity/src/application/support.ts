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
