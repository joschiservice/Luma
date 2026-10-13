/** Operational milestones retain their evidence category and never turn a read time into an occurrence time. */
type JourneyStage =
  | 'placed'
  | 'paid'
  | 'reserved'
  | 'picked'
  | 'shipped'
  | 'delivered'
  | 'returned';

type JourneyProvenance = 'provider_observation' | 'luma_action' | 'inference';

/** One part of an order can have independent shipment, return and reservation milestones. */
export interface JourneyEvent {
  id: string;
  orderId: string;
  partId: string;
  orderLineId: string | null;
  stage: JourneyStage;
  provenance: JourneyProvenance;
  connectionId: string | null;
  actorId: string | null;
  occurredAt: string | null;
  observedAt: string;
  quantity: string | null;
  unit: string | null;
  references: {
    kind:
      | 'order'
      | 'order_line'
      | 'shipment'
      | 'return'
      | 'invoice'
      | 'reservation'
      | 'snapshot'
      | 'observation'
      | 'activity';
    id: string;
    connectionId: string | null;
  }[];
}

export interface JourneyTiming {
  from: JourneyStage;
  to: JourneyStage;
  durationMs: number | null;
}

/** Measures only known occurrence times on the same part and source; observations cannot establish stage duration. */
export function journeyTiming(
  from: JourneyEvent,
  to: JourneyEvent,
): JourneyTiming {
  const start = from.occurredAt ? Date.parse(from.occurredAt) : NaN;
  const end = to.occurredAt ? Date.parse(to.occurredAt) : NaN;

  return {
    from: from.stage,
    to: to.stage,
    durationMs:
      from.orderId === to.orderId &&
      from.orderLineId === to.orderLineId &&
      from.partId === to.partId &&
      from.connectionId === to.connectionId &&
      from.provenance !== 'inference' &&
      to.provenance !== 'inference' &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end >= start
        ? end - start
        : null,
  };
}

/** Interpolates the workspace's known durations without counting unknown or negative pairs. */
export function journeyPercentiles(values: number[]): {
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
} {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const percentile = (p: number) => {
    if (!sorted.length) return null;
    const rank = (sorted.length - 1) * p,
      lower = Math.floor(rank),
      upper = Math.ceil(rank);

    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower);
  };

  return {
    count: sorted.length,
    medianMs: percentile(0.5),
    p90Ms: percentile(0.9),
  };
}

/** Candidate checks identify missing evidence for investigation, never a proven process violation. */
interface JourneyCandidate {
  code: 'paid_without_reservation' | 'shipped_without_reservation';
  orderLineId: string;
  connectionId: string;
  observedSince: string;
}

/** A bounded journey includes known-time workspace comparisons and explicit read limits. */
export interface OrderJourney {
  events: JourneyEvent[];
  truncated: boolean;
  candidates: JourneyCandidate[];
  timings: (JourneyTiming & {
    partId: string;
    orderLineId: string | null;
    connectionId: string | null;
  })[];
  comparisons: {
    from: JourneyStage;
    to: JourneyStage;
    count: number;
    medianMs: number | null;
    p90Ms: number | null;
  }[];
}
