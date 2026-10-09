import { z } from 'zod';

const gid = (kind: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${kind}/[0-9]+$`));

export const recoveryCapabilities = [
  'fulfillment.hold.release',
  'fulfillment.open',
  'fulfillment.move',
] as const;

export const recoveryCapability = z.enum(recoveryCapabilities);

export type RecoveryCapability = z.infer<typeof recoveryCapability>;

export const recoveryTarget = z
  .object({
    connectionId: z.string().uuid(),
    orderId: gid('Order'),
    fulfillmentOrderId: gid('FulfillmentOrder'),
  })
  .strict();

export const recoveryChoice = z.discriminatedUnion('capability', [
  z
    .object({
      capability: z.literal('fulfillment.hold.release'),
      holdId: gid('FulfillmentHold'),
    })
    .strict(),
  z.object({ capability: z.literal('fulfillment.open') }).strict(),
  z
    .object({
      capability: z.literal('fulfillment.move'),
      locationId: gid('Location'),
    })
    .strict(),
]);

export type RecoveryChoice = z.infer<typeof recoveryChoice>;

export const recoverySnapshot = z.object({
  id: z.string().uuid(),
  observedAt: z.string().datetime(),
  revision: z.string().min(1),
  orderId: gid('Order'),
  fulfillmentOrderId: gid('FulfillmentOrder'),
  status: z.string(),
  requestStatus: z.string(),
  locationId: gid('Location').nullable(),
  locationName: z.string(),
  actions: z.array(z.string()),
  holds: z.array(
    z.object({
      id: gid('FulfillmentHold'),
      reason: z.string(),
      heldByRequestingApp: z.boolean(),
    }),
  ),
  locations: z.array(
    z.object({ id: gid('Location'), name: z.string(), movable: z.boolean() }),
  ),
  complete: z.boolean(),
  lines: z.array(
    z.object({
      id: gid('LineItem'),
      remaining: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  ),
});

export type RecoverySnapshot = z.infer<typeof recoverySnapshot>;

/** Why a reviewed recovery is unsafe now. Interfaces translate these codes. */
export type RecoveryBlockerReason =
  | 'write_access'
  | 'incomplete'
  | 'closed'
  | 'not_allowed'
  | 'hold_gone'
  | 'cancellation_pending'
  | 'same_location'
  | 'location_unavailable';

const recoveryBlockerText: Record<RecoveryBlockerReason, string> = {
  write_access: 'Reconnect Shopify with fulfillment write access.',
  incomplete:
    'Shopify returned incomplete fulfillment details. Refresh before continuing.',
  closed: 'This fulfillment order is closed or cancelled.',
  not_allowed: 'Shopify does not allow this action in the current state.',
  hold_gone: 'The selected hold is no longer present.',
  cancellation_pending:
    'The fulfillment service must accept cancellation before this order can move.',
  same_location: 'Choose a different fulfillment location.',
  location_unavailable:
    'Shopify cannot move all remaining items to this location.',
};

/**
 * Finds why a reviewed recovery is unsafe using Shopify's current permissions and state, or
 * returns null when it may proceed.
 */
export function recoveryBlockerReason(
  snapshot: RecoverySnapshot,
  choice: RecoveryChoice,
  granted: readonly string[],
): RecoveryBlockerReason | null {
  if (!granted.includes(choice.capability)) return 'write_access';
  if (!snapshot.complete) return 'incomplete';
  if (['CLOSED', 'CANCELLED'].includes(snapshot.status)) return 'closed';
  const action = {
    'fulfillment.hold.release': 'RELEASE_HOLD',
    'fulfillment.open': 'MARK_AS_OPEN',
    'fulfillment.move': 'MOVE',
  }[choice.capability];
  if (!snapshot.actions.includes(action)) return 'not_allowed';
  if (
    choice.capability === 'fulfillment.hold.release' &&
    !snapshot.holds.some((hold) => hold.id === choice.holdId)
  )
    return 'hold_gone';
  if (choice.capability === 'fulfillment.move') {
    if (
      [
        'SUBMITTED',
        'ACCEPTED',
        'CANCELLATION_REQUESTED',
        'CANCELLATION_REJECTED',
      ].includes(snapshot.requestStatus)
    )
      return 'cancellation_pending';
    if (snapshot.locationId === choice.locationId) return 'same_location';
    if (
      !snapshot.locations.some(
        (location) => location.id === choice.locationId && location.movable,
      )
    )
      return 'location_unavailable';
  }

  return null;
}

/** Explains in English why a reviewed recovery is unsafe, for API responses and logs. */
export function recoveryBlocker(
  snapshot: RecoverySnapshot,
  choice: RecoveryChoice,
  granted: readonly string[],
): string | null {
  const reason = recoveryBlockerReason(snapshot, choice, granted);

  return reason ? recoveryBlockerText[reason] : null;
}

/** Requires an independent, complete read with fewer unfulfilled units on the reviewed lines. */
export function fulfillmentProgress(
  before: RecoverySnapshot,
  after: RecoverySnapshot,
): boolean {
  if (
    !before.complete ||
    !after.complete ||
    before.orderId !== after.orderId ||
    ['CANCELLED', 'INCOMPLETE'].includes(after.status)
  )
    return false;
  if (after.fulfillmentOrderId !== before.fulfillmentOrderId) return false;
  if (after.lines.length !== before.lines.length || !before.lines.length)
    return false;

  return (
    before.lines.every((line) =>
      after.lines.some(
        (current) =>
          current.id === line.id &&
          current.total === line.total &&
          current.remaining <= line.remaining,
      ),
    ) &&
    before.lines.some((line) =>
      after.lines.some(
        (current) =>
          current.id === line.id && current.remaining < line.remaining,
      ),
    )
  );
}

export const recoveryPreviewInput = recoveryTarget
  .extend({
    requestId: z.string().uuid(),
    choice: recoveryChoice,
  })
  .strict();

export const recoveryView = z.object({
  id: z.string().uuid(),
  target: recoveryTarget,
  choice: recoveryChoice,
  before: recoverySnapshot,
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

export type RecoveryView = z.infer<typeof recoveryView>;
