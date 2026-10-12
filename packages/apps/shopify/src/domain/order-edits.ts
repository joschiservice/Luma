import { z } from 'zod';

const gid = (kind: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${kind}/[0-9]+$`));

/** The installation capability and app permission that govern Shopify order quantity edits. */
export const orderEditCapability = 'orders.quantity.edit';

export const orderEditPermission = 'shopify:order_edits.apply';

/** Most lines one edit may change, so the bound intent stays within the action's parameter limits. */
export const maxEditedLines = 20;

/** How long after a lost commit Luma waits before a read without Shopify's edit proves it was not applied. */
export const commitGraceMs = 10 * 60_000;

/** Tolerated clock difference between Luma and Shopify when matching an edit agreement to its commit. */
const clockSkewMs = 5 * 60_000;

/** Prefix of the staff note that marks Luma's commit in Shopify's order timeline. */
export const orderEditMarker = (operationId: string) =>
  `luma-oe:${operationId}`;

export const orderEditTarget = z
  .object({ connectionId: z.string().uuid(), orderId: gid('Order') })
  .strict();

export type OrderEditTarget = z.infer<typeof orderEditTarget>;

const orderEditChange = z
  .object({
    lines: z
      .array(
        z
          .object({
            lineItemId: gid('LineItem'),
            quantity: z.number().int().min(0).max(100_000),
          })
          .strict(),
      )
      .min(1)
      .max(maxEditedLines)
      .refine(
        (lines) =>
          new Set(lines.map((line) => line.lineItemId)).size === lines.length,
      ),
    restock: z.boolean(),
  })
  .strict();

export type OrderEditChange = z.infer<typeof orderEditChange>;

const money = z.object({
  amount: z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
});

/** An amount in the shop's currency and in the customer's presentment currency. */
const moneyBag = z.object({ shop: money, presentment: money });

export type MoneyBag = z.infer<typeof moneyBag>;

export const orderEditSnapshot = z.object({
  id: z.string().uuid(),
  observedAt: z.string().datetime(),
  /**
   * Digest of Shopify's `updatedAt` and every fact an edit depends on. `updatedAt` alone has
   * second precision, so a change within the same second still alters the revision.
   */
  revision: z.string().min(1),
  updatedAt: z.string(),
  orderId: gid('Order'),
  cancelled: z.boolean(),
  closed: z.boolean(),
  totals: z.object({
    subtotal: moneyBag,
    total: moneyBag,
    outstanding: moneyBag,
  }),
  lines: z.array(
    z.object({
      id: gid('LineItem'),
      name: z.string(),
      sku: z.string().nullable(),
      quantity: z.number().int().nonnegative(),
      currentQuantity: z.number().int().nonnegative(),
      unfulfilledQuantity: z.number().int().nonnegative(),
    }),
  ),
  fulfillmentOrders: z.array(
    z.object({
      id: gid('FulfillmentOrder'),
      status: z.string(),
      requestStatus: z.string(),
      lines: z.array(
        z.object({
          lineItemId: gid('LineItem'),
          remaining: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
  /** False when any collection was truncated; an incomplete read never authorizes an edit. */
  complete: z.boolean(),
});

export type OrderEditSnapshot = z.infer<typeof orderEditSnapshot>;

/** Shopify's non-committing calculation of the staged edit. */
const orderEditCalculation = z.object({
  id: z.string().uuid(),
  observedAt: z.string().datetime(),
  subtotal: moneyBag.nullable(),
  total: moneyBag,
  outstanding: moneyBag,
  /** Calculated current quantity per order line. */
  lines: z.array(
    z.object({
      lineItemId: gid('LineItem'),
      quantity: z.number().int().nonnegative(),
    }),
  ),
});

export type OrderEditCalculation = z.infer<typeof orderEditCalculation>;

/** The workspace's line authority when the preview was read. */
export const orderLineAuthority = z.object({
  revision: z.number().int().nonnegative(),
  state: z.enum(['resolved', 'unknown', 'conflicting']),
  connectionId: z.string().uuid().nullable(),
});

export type OrderLineAuthority = z.infer<typeof orderLineAuthority>;

/** Why an edit is unsafe now. Interfaces translate these codes. */
export type OrderEditBlockerReason =
  | 'write_access'
  | 'incomplete'
  | 'cancelled'
  | 'closed'
  | 'authority'
  | 'unknown_line'
  | 'no_change'
  | 'partially_fulfilled'
  | 'fulfillment_started'
  | 'fulfillment_requested'
  | 'fulfillment_unknown';

const blockerText: Record<OrderEditBlockerReason, string> = {
  write_access: 'Reconnect Shopify with order edit access.',
  incomplete:
    'Shopify returned incomplete order details. Refresh before continuing.',
  cancelled: 'This order is cancelled.',
  closed: 'This order is closed.',
  authority:
    'Order lines in this workspace do not come from this Shopify store. Review source authority before editing.',
  unknown_line: 'A selected line is no longer on this order.',
  no_change: 'Choose a quantity that differs from the current quantity.',
  partially_fulfilled: 'Some units of a selected line are already fulfilled.',
  fulfillment_started: 'Fulfillment of a selected line has started.',
  fulfillment_requested:
    'A selected line was sent to a fulfillment service. Cancel that request first.',
  fulfillment_unknown:
    'Shopify reports fulfillment work Luma cannot confirm as unstarted.',
};

/** Work statuses whose units have not started; ON_HOLD is safe but noted. */
const unstarted = ['OPEN', 'SCHEDULED', 'ON_HOLD'];

/** Finished work holds no remaining units of an untouched line. */
const finished = ['CLOSED', 'CANCELLED'];

/**
 * Checks one line's fulfillment work: every work order holding its remaining units must be
 * unstarted and never submitted to a fulfillment service, no unit may be fulfilled, and the
 * remaining units must equal Shopify's unfulfilled count. Unknown states are never safe.
 */
export function lineBlockerReason(
  snapshot: OrderEditSnapshot,
  lineItemId: string,
): OrderEditBlockerReason | null {
  const line = snapshot.lines.find((item) => item.id === lineItemId);
  if (!line) return 'unknown_line';
  if (line.unfulfilledQuantity !== line.currentQuantity)
    return 'partially_fulfilled';
  let remaining = 0;
  for (const work of snapshot.fulfillmentOrders) {
    const units = work.lines.filter((item) => item.lineItemId === lineItemId);
    if (!units.length) continue;
    const open = units.reduce((sum, item) => sum + item.remaining, 0);
    if (finished.includes(work.status)) {
      if (open > 0) return 'fulfillment_unknown';
      continue;
    }
    if (['IN_PROGRESS', 'INCOMPLETE'].includes(work.status))
      return 'fulfillment_started';
    if (!unstarted.includes(work.status)) return 'fulfillment_unknown';
    if (work.requestStatus !== 'UNSUBMITTED')
      return [
        'SUBMITTED',
        'ACCEPTED',
        'REJECTED',
        'CANCELLATION_REQUESTED',
        'CANCELLATION_ACCEPTED',
        'CANCELLATION_REJECTED',
        'CLOSED',
      ].includes(work.requestStatus)
        ? 'fulfillment_requested'
        : 'fulfillment_unknown';
    remaining += open;
  }

  return remaining === line.unfulfilledQuantity ? null : 'fulfillment_unknown';
}

/**
 * Finds why an edit is unsafe on this read, or returns null when Luma may calculate and send it.
 * Line authority must resolve to the same connection; a missing reader counts as unknown.
 */
export function orderEditBlockerReason(
  snapshot: OrderEditSnapshot,
  change: OrderEditChange,
  access: {
    connectionId: string;
    granted: readonly string[];
    authority: OrderLineAuthority | null;
  },
): OrderEditBlockerReason | null {
  if (!access.granted.includes(orderEditCapability)) return 'write_access';
  if (!snapshot.complete) return 'incomplete';
  if (snapshot.cancelled) return 'cancelled';
  if (snapshot.closed) return 'closed';
  if (
    access.authority?.state !== 'resolved' ||
    access.authority.connectionId !== access.connectionId
  )
    return 'authority';
  for (const target of change.lines) {
    const line = snapshot.lines.find((item) => item.id === target.lineItemId);
    if (!line) return 'unknown_line';
    if (line.currentQuantity === target.quantity) return 'no_change';
    const reason = lineBlockerReason(snapshot, target.lineItemId);
    if (reason) return reason;
  }

  return null;
}

/** Explains in English why an edit is unsafe, for API responses and logs. */
export function orderEditBlocker(
  ...args: Parameters<typeof orderEditBlockerReason>
): string | null {
  const reason = orderEditBlockerReason(...args);

  return reason ? blockerText[reason] : null;
}

/** Whether any work holding a changed line is on hold; the edit is allowed but people are told. */
export function editTouchesHold(
  snapshot: OrderEditSnapshot,
  change: OrderEditChange,
) {
  return snapshot.fulfillmentOrders.some(
    (work) =>
      work.status === 'ON_HOLD' &&
      work.lines.some((line) =>
        change.lines.some((item) => item.lineItemId === line.lineItemId),
      ),
  );
}

/** Pairs each approved line with the quantity the preview read, in a stable order. */
export function editedLines(
  snapshot: OrderEditSnapshot,
  change: OrderEditChange,
) {
  return change.lines
    .map((target) => ({
      lineItemId: target.lineItemId,
      currentQuantity:
        snapshot.lines.find((line) => line.id === target.lineItemId)
          ?.currentQuantity ?? 0,
      quantity: target.quantity,
    }))
    .sort((a, b) => a.lineItemId.localeCompare(b.lineItemId));
}

/** The order facts an edit depends on, without read identity and time. */
export function editFacts(snapshot: OrderEditSnapshot) {
  return JSON.stringify({
    cancelled: snapshot.cancelled,
    closed: snapshot.closed,
    complete: snapshot.complete,
    lines: snapshot.lines.map((line) => [
      line.id,
      line.currentQuantity,
      line.unfulfilledQuantity,
    ]),
    work: snapshot.fulfillmentOrders.map((work) => [
      work.id,
      work.status,
      work.requestStatus,
      work.lines.map((line) => [line.lineItemId, line.remaining, line.total]),
    ]),
  });
}

/** A Shopify sales agreement as reconciliation reads it. */
export interface EditAgreement {
  id: string;
  reason: string;
  happenedAt: string;
  appId: string | null;
  /** Signed unit changes per order line from product sales: removals negative, additions positive. */
  deltas: Record<string, number>;
  /** False when the agreement's sales were truncated. */
  complete: boolean;
}

/** Independent evidence about whether Luma's edit reached Shopify. */
export interface EditProof {
  observedAt: string;
  appId: string;
  agreements: EditAgreement[];
  /** False when agreements or lines were truncated. */
  complete: boolean;
  cancelled: boolean;
  lines: { id: string; currentQuantity: number }[];
}

/** Luma's one-shot commit fence for an operation. */
export interface EditFence {
  state: 'reserved' | 'sent' | 'accepted' | 'withheld' | 'rejected';
  sentAt: string | null;
}

/**
 * Decides from independent reads whether an edit was committed. `committed` needs an edit
 * agreement by this app after the commit was sent whose sales match the approved changes, and
 * the lines at the approved quantities. `not_committed` needs either a fence that was never
 * sent, or a sent commit past the grace window with no edit by this app and the lines still at
 * their reviewed quantities. Everything else is `unknown`; Luma never replays the commit.
 */
export function editOutcome(
  lines: { lineItemId: string; currentQuantity: number; quantity: number }[],
  fence: EditFence | null,
  proof: EditProof,
  now: Date,
): 'committed' | 'not_committed' | 'unknown' {
  if (fence && ['withheld', 'rejected'].includes(fence.state))
    return 'not_committed';
  if (!fence?.sentAt || !proof.complete) return 'unknown';
  const since = Date.parse(fence.sentAt) - clockSkewMs;
  const ours = proof.agreements.filter(
    (agreement) =>
      agreement.reason === 'ORDER_EDIT' &&
      agreement.appId === proof.appId &&
      Date.parse(agreement.happenedAt) >= since,
  );
  const quantity = (id: string) =>
    proof.lines.find((line) => line.id === id)?.currentQuantity;
  const matching = ours.filter(
    (agreement) =>
      agreement.complete &&
      Object.entries(agreement.deltas).every(
        ([id, delta]) =>
          delta === 0 || lines.some((line) => line.lineItemId === id),
      ) &&
      lines.every(
        (line) =>
          (agreement.deltas[line.lineItemId] ?? 0) ===
          line.quantity - line.currentQuantity,
      ),
  );
  if (
    matching.length === 1 &&
    !proof.cancelled &&
    lines.every((line) => quantity(line.lineItemId) === line.quantity)
  )
    return 'committed';
  if (
    fence.state === 'sent' &&
    !ours.length &&
    now.getTime() - Date.parse(fence.sentAt) >= commitGraceMs &&
    lines.every((line) => quantity(line.lineItemId) === line.currentQuantity)
  )
    return 'not_committed';

  return 'unknown';
}

export const orderEditPreviewInput = orderEditTarget
  .extend({ requestId: z.string().uuid(), change: orderEditChange })
  .strict();

export const orderEditView = z.object({
  observeOnly: z.boolean().optional(),
  id: z.string().uuid(),
  target: orderEditTarget,
  change: orderEditChange,
  lines: z.array(
    z.object({
      lineItemId: gid('LineItem'),
      currentQuantity: z.number().int().nonnegative(),
      quantity: z.number().int().nonnegative(),
    }),
  ),
  before: orderEditSnapshot,
  /** Null when writes are off: observe-only previews never ask Shopify to calculate. */
  calculation: orderEditCalculation.nullable(),
  authority: orderLineAuthority,
  onHold: z.boolean(),
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
  /** Someone else who can approve changes approved this exact edit. */
  approved: z.boolean().default(false),
  /**
   * Why a denied edit stopped; null unless the state is `denied`. `not_applied` means reads
   * proved a sent commit never took effect.
   */
  denial: z
    .enum([
      'rejected',
      'expired',
      'changed',
      'policy',
      'withheld',
      'not_applied',
    ])
    .nullable()
    .default(null),
  acceptance: z.enum(['not_sent', 'accepted', 'unknown']),
  message: z.string(),
  canExecute: z.boolean(),
  canApprove: z.boolean(),
});

export type OrderEditView = z.infer<typeof orderEditView>;
