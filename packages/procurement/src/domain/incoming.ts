import type { Commitment, FollowUp, Submission } from './commitments.js';
import { defaultSupplierTerms, orderProgress } from './commitments.js';
import type { PurchaseOrder } from './procurement.js';

export interface IncomingItem {
  key: string;
  source: 'purchase_order' | 'transfer' | 'ledger';
  skuId: string;
  locationId: string | null;
  location: string | null;
  quantity: number;
  unit: string;
  expectedDate: string | null;
  dateStatus: 'confirmed' | 'requested' | 'overdue' | 'unknown';
  orderId: string | null;
  orderReference: string | null;
  supplierId: string | null;
  supplierName: string | null;
  transferId: string | null;
  observedAt: string;
  freshness: 'fresh' | 'stale';
  evidenceRefs: string[];
}

/** Projects only open supplier arrivals; receipts, cancellations and decisions reduce outstanding units. */
export function supplierIncoming(input: {
  order: PurchaseOrder;
  submission: Submission | null;
  commitments: Commitment[];
  followUps: FollowUp[];
  aliases: Map<string, string>;
  locations: Map<string, string>;
  ownedLocations: Set<string>;
  now: Date;
  /** The workspace IANA time zone, which sets the calendar day for overdue dates. */
  timeZone: string;
}): IncomingItem[] {
  if (
    input.order.status !== 'open' ||
    input.order.externalReferences.some((reference) =>
      ['shopify_inventory_transfer', 'shopify_inventory_shipment'].includes(
        reference.system,
      ),
    )
  )
    return [];
  const progress = orderProgress({
    ...input,
    terms: defaultSupplierTerms,
    draftVerified: false,
    supplierLinked: false,
  });

  return progress.lines.flatMap((line) => {
    const skuId = input.aliases.get(line.sku);
    const orderLine = input.order.lines.find(
      (value) => value.id === line.lineId,
    )!;
    const locationId = orderLine.locationId ?? null;
    if (
      !skuId ||
      line.outstanding <= 0 ||
      (locationId && input.ownedLocations.has(locationId))
    )
      return [];
    const facts = input.commitments.filter(
      (value) =>
        value.status === 'confirmed' &&
        (value.lineId === line.lineId || value.lineId === null),
    );
    const observedAt =
      facts
        .map((value) =>
          value.source.kind === 'purchasing_system'
            ? value.source.observedAt
            : value.recordedAt,
        )
        .sort()
        .at(-1) ??
      input.submission?.submittedAt ??
      input.order.updatedAt;
    const age = input.now.getTime() - Date.parse(observedAt);

    return [
      {
        key: `purchase_order:${input.order.id}:${line.lineId}`,
        source: 'purchase_order' as const,
        skuId,
        locationId,
        location: locationId ? (input.locations.get(locationId) ?? null) : null,
        quantity: line.outstanding,
        unit: line.unit,
        expectedDate: line.expectedDate,
        dateStatus: line.overdue
          ? ('overdue' as const)
          : line.promisedDate
            ? ('confirmed' as const)
            : line.requestedDate
              ? ('requested' as const)
              : ('unknown' as const),
        orderId: input.order.id,
        orderReference: input.order.reference,
        supplierId: input.order.supplierId,
        supplierName: input.order.supplierName,
        transferId: null,
        observedAt,
        freshness:
          age >= 0 && age <= 86_400_000
            ? ('fresh' as const)
            : ('stale' as const),
        evidenceRefs: [input.order.id, ...facts.map((value) => value.id)],
      },
    ];
  });
}

/** Labels expected arrival evidence without making a passed estimate look like a future promise. */
export function arrivalStatus(
  date: string | null,
  now: Date,
): IncomingItem['dateStatus'] {
  return date
    ? date.slice(0, 10) < now.toISOString().slice(0, 10)
      ? 'overdue'
      : 'requested'
    : 'unknown';
}

export interface IncomingStockQuery {
  skuIds: string[];
  locationId?: string | undefined;
}

export interface IncomingStock {
  enabled: boolean;
  items: IncomingItem[];
  truncated: boolean;
  supplierOrdersUnavailable: boolean;
  unavailableNativeIncoming: boolean;
  asOf: string;
}
