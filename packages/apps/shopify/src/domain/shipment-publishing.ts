import { z } from 'zod';

const gid = (kind: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${kind}/[0-9]+$`));

export const publishingCapabilities = [
  'fulfillment.shipment.create',
  'fulfillment.tracking.update',
] as const;

export type PublishingCapability = (typeof publishingCapabilities)[number];

export const publishingTarget = z
  .object({ connectionId: z.string().uuid(), orderId: gid('Order') })
  .strict();

export const dispatchReference = z
  .object({
    downstreamConnectionId: z.string().uuid(),
    shipmentId: z.string().min(1).max(200),
  })
  .strict();

const tracking = z.object({
  company: z.string().min(1).max(120).nullable(),
  number: z.string().min(1).max(200),
  url: z
    .string()
    .url()
    .refine((v) => new URL(v).protocol === 'https:')
    .nullable(),
});

const dispatchEvidence = z.object({
  id: z.string().uuid(),
  observationId: z.string().uuid(),
  observedAt: z.string().datetime(),
  revision: z.string(),
  complete: z.boolean(),
  connectionId: z.string().uuid(),
  shipmentId: z.string(),
  stage: z.enum(['carrier', 'delivered', 'unknown']),
  locationId: gid('Location').nullable(),
  lines: z
    .array(
      z.object({
        orderLineId: gid('LineItem'),
        quantity: z.number().int().positive(),
      }),
    )
    .max(100),
  tracking: z.array(tracking).min(1).max(20),
});

export type DispatchEvidence = z.infer<typeof dispatchEvidence>;

const allocation = z
  .object({
    fulfillmentOrderId: gid('FulfillmentOrder'),
    fulfillmentOrderLineId: gid('FulfillmentOrderLineItem'),
    orderLineId: gid('LineItem'),
    locationId: gid('Location'),
    quantity: z.number().int().positive(),
  })
  .strict();

const publishingChoice = z.discriminatedUnion('capability', [
  z
    .object({
      capability: z.literal('fulfillment.shipment.create'),
      source: dispatchReference,
      allocations: z.array(allocation).min(1).max(100),
      notifyCustomer: z.boolean(),
      allocationSource: z.enum(['provider', 'operator']).default('provider'),
    })
    .strict(),
  z
    .object({
      capability: z.literal('fulfillment.tracking.update'),
      source: dispatchReference,
      fulfillmentId: gid('Fulfillment'),
      confirmedAllocation: z
        .object({
          locationId: gid('Location'),
          lines: z
            .array(
              z.object({
                orderLineId: gid('LineItem'),
                quantity: z.number().int().positive(),
              }),
            )
            .min(1)
            .max(100),
        })
        .optional(),
      notifyCustomer: z.boolean(),
      allocationSource: z.enum(['provider', 'operator']).default('provider'),
    })
    .strict(),
]);

export type PublishingChoice = z.infer<typeof publishingChoice>;

export const publishingSnapshot = z.object({
  id: z.string().uuid(),
  observedAt: z.string().datetime(),
  revision: z.string(),
  orderId: gid('Order'),
  cancelled: z.boolean(),
  complete: z.boolean(),
  work: z.array(
    z.object({
      id: gid('FulfillmentOrder'),
      status: z.string(),
      requestStatus: z.string(),
      actions: z.array(z.string()),
      locationId: gid('Location').nullable(),
      locationName: z.string().default(''),
      lines: z.array(
        z.object({
          id: gid('FulfillmentOrderLineItem'),
          orderLineId: gid('LineItem'),
          name: z.string().default(''),
          remaining: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
  shipments: z.array(
    z.object({
      id: gid('Fulfillment'),
      fulfillmentOrderIds: z.array(gid('FulfillmentOrder')),
      status: z.string(),
      locationId: gid('Location').nullable(),
      lines: z.array(
        z.object({
          orderLineId: gid('LineItem'),
          quantity: z.number().int().positive(),
        }),
      ),
      tracking: z.array(tracking),
    }),
  ),
  dispatch: dispatchEvidence.nullable(),
});

export type PublishingSnapshot = z.infer<typeof publishingSnapshot>;

export const publishingPreviewInput = publishingTarget
  .extend({ requestId: z.string().uuid(), choice: publishingChoice })
  .strict();

export const publishingView = z.object({
  observeOnly: z.boolean().optional(),
  id: z.string().uuid(),
  target: publishingTarget,
  choice: publishingChoice,
  before: publishingSnapshot,
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
  approved: z.boolean().default(false),
  denial: z
    .enum(['rejected', 'expired', 'changed', 'policy', 'withheld'])
    .nullable()
    .default(null),
  acceptance: z.enum(['not_sent', 'accepted', 'unknown']),
  message: z.string(),
  canExecute: z.boolean(),
  canApprove: z.boolean(),
});

export type PublishingView = z.infer<typeof publishingView>;

function quantities(lines: { orderLineId: string; quantity: number }[]) {
  const result = new Map<string, number>();
  for (const line of lines)
    result.set(
      line.orderLineId,
      (result.get(line.orderLineId) ?? 0) + line.quantity,
    );

  return result;
}

/** Compares exact line allocations, including every line and whole unit. */
function sameAllocation(
  a: { orderLineId: string; quantity: number }[],
  b: { orderLineId: string; quantity: number }[],
) {
  const left = quantities(a),
    right = quantities(b);

  return (
    left.size === right.size &&
    [...left].every(([id, q]) => right.get(id) === q)
  );
}

/** Checks supported physical dispatch, exact mappings, scope and current Shopify work before publishing. */
export function publishingBlocker(
  snapshot: PublishingSnapshot,
  choice: PublishingChoice,
  granted: readonly string[],
  now = Date.now(),
): string | null {
  if (!granted.includes(choice.capability))
    return 'Reconnect Shopify with shipment write access.';
  if (!snapshot.complete)
    return 'Shopify returned incomplete shipment evidence.';
  if (snapshot.cancelled) return 'This order is cancelled.';
  const source = snapshot.dispatch;
  if (
    !source ||
    !source.complete ||
    !['carrier', 'delivered'].includes(source.stage)
  )
    return 'A complete downstream read must confirm physical dispatch. A label is not dispatch evidence.';
  if (
    source.connectionId !== choice.source.downstreamConnectionId ||
    source.shipmentId !== choice.source.shipmentId
  )
    return 'Downstream dispatch identity changed.';
  const age = now - Date.parse(source.observedAt);
  if (age < 0 || age > 5 * 60_000)
    return 'Refresh downstream dispatch evidence before publishing.';
  if (
    new Set(source.tracking.map((t) => t.company)).size !== 1 ||
    new Set(source.tracking.map((t) => t.number)).size !==
      source.tracking.length
  )
    return 'Tracking identity is ambiguous.';
  if (choice.capability === 'fulfillment.shipment.create') {
    if (snapshot.shipments.length >= 4)
      return 'This order reaches the shipment verification limit. Review it directly in Shopify.';
    if (
      new Set(choice.allocations.map((a) => a.fulfillmentOrderLineId)).size !==
      choice.allocations.length
    )
      return 'Choose each fulfillment-order line once.';
    if (
      new Set(choice.allocations.map((a) => a.locationId)).size !== 1 ||
      (source.locationId !== null &&
        choice.allocations.some((a) => a.locationId !== source.locationId)) ||
      (source.locationId === null && choice.allocationSource !== 'operator')
    )
      return 'The downstream warehouse must map to the exact Shopify location.';
    if (
      (source.lines.length > 0 &&
        !sameAllocation(choice.allocations, source.lines)) ||
      (source.lines.length === 0 && choice.allocationSource !== 'operator')
    )
      return 'Approved units must exactly match the dispatched shipment.';
    for (const a of choice.allocations) {
      const work = snapshot.work.find((w) => w.id === a.fulfillmentOrderId);
      const line = work?.lines.find((l) => l.id === a.fulfillmentOrderLineId);
      if (
        !work ||
        !line ||
        line.orderLineId !== a.orderLineId ||
        work.locationId !== a.locationId ||
        line.remaining < a.quantity ||
        !['OPEN', 'IN_PROGRESS'].includes(work.status) ||
        work.requestStatus !== 'UNSUBMITTED' ||
        !work.actions.includes('CREATE_FULFILLMENT')
      )
        return 'Shopify no longer allows these exact lines and quantities at this location.';
    }
    if (
      snapshot.shipments.some(
        (s) =>
          s.status === 'SUCCESS' &&
          s.tracking.some((t) =>
            source.tracking.some((d) => d.number === t.number),
          ),
      )
    )
      return 'This downstream shipment already has a Shopify fulfillment.';
  } else {
    const shipment = snapshot.shipments.find(
      (s) => s.id === choice.fulfillmentId,
    );
    const confirmed =
      choice.allocationSource === 'operator'
        ? choice.confirmedAllocation
        : undefined;
    const lines = source.lines.length ? source.lines : confirmed?.lines;
    const location = source.locationId ?? confirmed?.locationId;
    if (
      !shipment ||
      shipment.status !== 'SUCCESS' ||
      !lines ||
      !location ||
      shipment.locationId !== location ||
      !sameAllocation(shipment.lines, lines) ||
      (confirmed &&
        (!sameAllocation(confirmed.lines, shipment.lines) ||
          confirmed.locationId !== shipment.locationId))
    )
      return 'The Shopify fulfillment must match the exact dispatched lines and location.';
  }

  return null;
}

/** Fresh independent read verifies a unique fulfillment with exact allocation, location and tracking. */
export function verifiedPublishingFulfillment(
  before: PublishingSnapshot,
  choice: PublishingChoice,
  after: PublishingSnapshot,
) {
  if (
    !after.complete ||
    after.cancelled ||
    after.orderId !== before.orderId ||
    Date.parse(after.observedAt) < Date.parse(before.observedAt) ||
    !before.dispatch
  )
    return null;
  const source = before.dispatch;
  const lines =
    choice.capability === 'fulfillment.shipment.create'
      ? choice.allocations
      : source.lines.length
        ? source.lines
        : (choice.confirmedAllocation?.lines ?? []);
  const location =
    choice.capability === 'fulfillment.shipment.create'
      ? choice.allocations[0]?.locationId
      : (source.locationId ?? choice.confirmedAllocation?.locationId);
  const expectedWork =
    choice.capability === 'fulfillment.shipment.create'
      ? [...new Set(choice.allocations.map((a) => a.fulfillmentOrderId))]
      : (before.shipments.find((s) => s.id === choice.fulfillmentId)
          ?.fulfillmentOrderIds ?? []);
  if (
    choice.capability === 'fulfillment.shipment.create' &&
    choice.allocations.some((a) => {
      const old = before.work
          .find((w) => w.id === a.fulfillmentOrderId)
          ?.lines.find((l) => l.id === a.fulfillmentOrderLineId),
        current = after.work
          .find((w) => w.id === a.fulfillmentOrderId)
          ?.lines.find((l) => l.id === a.fulfillmentOrderLineId);

      return (
        !old ||
        !current ||
        current.orderLineId !== old.orderLineId ||
        current.total !== old.total ||
        current.remaining !== old.remaining - a.quantity
      );
    })
  )
    return null;
  const matches = after.shipments.filter(
    (s) =>
      s.status === 'SUCCESS' &&
      s.fulfillmentOrderIds.length === expectedWork.length &&
      expectedWork.every((id) => s.fulfillmentOrderIds.includes(id)) &&
      s.locationId === location &&
      sameAllocation(s.lines, lines) &&
      s.tracking.length === source.tracking.length &&
      source.tracking.every((t) =>
        s.tracking.some(
          (v) =>
            v.number === t.number &&
            v.company === t.company &&
            (t.url === null || v.url === t.url),
        ),
      ) &&
      (choice.capability === 'fulfillment.tracking.update'
        ? s.id === choice.fulfillmentId
        : !before.shipments.some((old) => old.id === s.id)),
  );

  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

/** Verifies the exact saved publication using an independent provider read. */
export function publishingVerified(
  before: PublishingSnapshot,
  choice: PublishingChoice,
  after: PublishingSnapshot,
) {
  return verifiedPublishingFulfillment(before, choice, after) !== null;
}
