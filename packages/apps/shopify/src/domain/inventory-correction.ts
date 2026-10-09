import { z } from 'zod';

export const correctionCapabilities = [
  'inventory.available.reconcile',
] as const;

export const correctionTarget = z
  .object({
    positionId: z.string().uuid(),
    connectionId: z.string().uuid(),
    sourceConnectionId: z.string().uuid(),
  })
  .strict();

export const correctionChoice = z
  .object({ capability: z.literal('inventory.available.reconcile') })
  .strict();

export type CorrectionChoice = z.infer<typeof correctionChoice>;

export const correctionSnapshot = z.object({
  id: z.string().uuid(),
  observedAt: z.string().datetime(),
  revision: z.string(),
  targetRevision: z.string(),
  inventoryItemId: z.string().regex(/^gid:\/\/shopify\/InventoryItem\/[0-9]+$/),
  locationId: z.string().regex(/^gid:\/\/shopify\/Location\/[0-9]+$/),
  locationName: z.string(),
  available: z.number().int().nullable(),
  tracked: z.boolean(),
  complete: z.boolean(),
  source: z.object({
    connectionId: z.string().uuid(),
    label: z.string(),
    observationId: z.string().uuid(),
    observedAt: z.string().datetime(),
    revision: z.string(),
    available: z.number().int().nonnegative(),
  }),
});

export type CorrectionSnapshot = z.infer<typeof correctionSnapshot>;

/** Why a stock correction can't be reviewed now. Interfaces translate these codes. */
export type CorrectionBlockerReason =
  'write_access' | 'untracked' | 'stale' | 'already_matches';

const correctionBlockerText: Record<CorrectionBlockerReason, string> = {
  write_access: 'Reconnect Shopify with inventory write access.',
  untracked:
    'Shopify did not confirm tracked inventory at this exact location.',
  stale:
    'Stock evidence is stale. Sync the ERP and refresh before reviewing a correction.',
  already_matches:
    'Shopify already matches the ERP quantity. No correction is needed.',
};

/**
 * Admits only ERP-to-Shopify reconciliation of fresh, known, whole-unit available quantities.
 * Returns the reason a correction is blocked, or null when it may be reviewed.
 */
export function correctionBlockerReason(
  snapshot: CorrectionSnapshot,
  _choice: CorrectionChoice,
  granted: readonly string[],
  now = new Date(),
): CorrectionBlockerReason | null {
  if (!granted.includes('inventory.available.reconcile')) return 'write_access';
  if (!snapshot.complete || !snapshot.tracked || snapshot.available === null)
    return 'untracked';
  for (const observedAt of [snapshot.observedAt, snapshot.source.observedAt]) {
    const age = now.getTime() - Date.parse(observedAt);
    if (age < 0 || age >= 5 * 60_000) return 'stale';
  }
  if (snapshot.available === snapshot.source.available)
    return 'already_matches';

  return null;
}

/** Explains in English why a correction is blocked, for API responses and logs. */
export function correctionBlocker(
  snapshot: CorrectionSnapshot,
  choice: CorrectionChoice,
  granted: readonly string[],
  now = new Date(),
): string | null {
  const reason = correctionBlockerReason(snapshot, choice, granted, now);

  return reason ? correctionBlockerText[reason] : null;
}

/** Requires a new complete Shopify read of the exact target and unchanged ERP authority. */
export function inventoryReconciled(
  before: CorrectionSnapshot,
  after: CorrectionSnapshot,
): boolean {
  return (
    after.id !== before.id &&
    Date.parse(after.observedAt) >= Date.parse(before.observedAt) &&
    after.complete &&
    after.tracked &&
    after.inventoryItemId === before.inventoryItemId &&
    after.locationId === before.locationId &&
    after.source.revision === before.source.revision &&
    after.source.connectionId === before.source.connectionId &&
    after.available === before.source.available
  );
}

export const correctionPreviewInput = correctionTarget
  .extend({ requestId: z.string().uuid() })
  .strict();

export const correctionView = z.object({
  id: z.string().uuid(),
  target: correctionTarget,
  choice: correctionChoice,
  before: correctionSnapshot,
  requesterId: z.string(),
  expiresAt: z.string().datetime(),
  decisionId: z.string().uuid().nullable(),
  state: z.enum([
    'preview',
    'approval_required',
    'denied',
    'accepted',
    'uncertain',
    'verified',
    'recovery_required',
  ]),
  /** Someone else who can approve changes approved this exact action. */
  approved: z.boolean().default(false),
  /** Why a denied action stopped; null unless the state is `denied`. */
  denial: z
    .enum(['rejected', 'expired', 'changed', 'policy', 'withheld'])
    .nullable()
    .default(null),
  acceptance: z.enum(['not_sent', 'accepted', 'unknown']),
  message: z.string(),
  canExecute: z.boolean(),
  canApprove: z.boolean(),
});

export type CorrectionView = z.infer<typeof correctionView>;

export const correctionCandidate = z.object({
  connectionId: z.string().uuid(),
  label: z.string(),
  provider: z.string(),
  available: z.string().nullable(),
  observedAt: z.string(),
});

export type CorrectionCandidate = z.infer<typeof correctionCandidate>;
