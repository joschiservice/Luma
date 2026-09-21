/** Preserves rejections and live approvals; expired approvals require a new proposal and decision. */
export function approvalBlocksRenewal(
  approval: { outcome: 'approved' | 'rejected'; expiresAt: string } | null,
  now: number,
) {
  return Boolean(
    approval &&
    (approval.outcome === 'rejected' ||
      !(Date.parse(approval.expiresAt) <= now)),
  );
}
