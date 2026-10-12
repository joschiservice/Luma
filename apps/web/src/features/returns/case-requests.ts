/** Keeps uncertain retries on their original identity; confirmed unsent terminal attempts need a new approval. */
export function retryableReturnRequestId(
  id: string | undefined,
  attempt:
    | {
        state: string;
        sent: boolean;
        decisionId: string | null;
        expiresAt: string;
      }
    | undefined,
  now: number,
) {
  if (!id || !attempt || attempt.sent) return id;
  const terminal =
    ['rejected', 'expired', 'not_executed'].includes(attempt.state) ||
    (attempt.state === 'failed' && attempt.decisionId !== null) ||
    (['approval_required', 'approved'].includes(attempt.state) &&
      Date.parse(attempt.expiresAt) <= now);

  return terminal ? undefined : id;
}
