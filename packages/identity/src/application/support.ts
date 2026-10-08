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
