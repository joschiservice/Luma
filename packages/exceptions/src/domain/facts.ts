interface Thresholds {
  freshnessSeconds: number;
  pairSkewSeconds: number;
  syncFailureSeconds: number;
  stuckSeconds: number;
  uncertaintySeconds: number;
  /**
   * How long a stock gap may wait for provider sync after Luma first saw it, and how long every
   * source of an order must keep showing a line quantity difference before it opens a case.
   */
  propagationSeconds: number;
  /** Short confirmation window for storefront overstatement; zero alerts immediately. */
  oversellPropagationSeconds?: number | undefined;
  /**
   * Storefront overstatement, in percent of the authority's available stock, that is raised at
   * once instead of waiting for sync.
   */
  oversellGuardPercent: number;
  /**
   * How long a stock authority's change may stay unmatched by the storefront before it counts as
   * not followed by the merchant's stock sync.
   */
  stallSeconds?: number | undefined;
  /** Positions that must stay unfollowed, on fresh reads, before a stalled sync is raised. */
  stallMinPositions?: number | undefined;
  /** Share of recently changed positions, in percent, that must be unfollowed. */
  stallSharePercent?: number | undefined;
}

export interface Configuration {
  version: string;
  ruleVersion: 'v0.2';
  inventoryTolerance: string;
  thresholds: Thresholds;
}

interface Common {
  tenantId: string;
  evidenceTenantId: string;
  subjectId: string;
  evidenceRefs: string[];
}

interface FactMap {
  sync_failure: Common & {
    connectionId: string;
    capability:
      'inventory.read' | 'orders.read' | 'fulfillment.read' | 'products.read';
    active: boolean;
    /** The provider rejected Luma's credentials or grants, and nobody reconnected since. */
    accessLost?: boolean;
    status: 'failed' | 'success';
    errorCode:
      | 'authentication'
      | 'permission_denied'
      | 'invalid_response'
      | 'export_unavailable'
      | 'unsupported_capability'
      | 'unsupported_version'
      | 'transient'
      | 'timeout'
      | 'rate_limited'
      | 'internal'
      | 'unavailable'
      | 'invalid_input'
      | 'not_found'
      | 'conflict'
      | null;
    firstFailureAt: string;
    retryExhausted: boolean;
    scanComplete: boolean;
  };
  stuck_fulfillment: Common & {
    connectionId: string;
    status:
      | 'pending'
      | 'processing'
      | 'completed'
      | 'shipped'
      | 'delivered'
      | 'cancelled'
      | 'failed'
      | 'unknown';
    observedAt: string;
    lastProgressAt: string | null;
    quantity: string | null;
    unit: string;
    mapped: boolean;
    complete: boolean;
    eligibility: 'eligible' | 'exempt' | 'unknown';
    progressBasis:
      'note_created_or_package_shipped' | 'source_updated' | 'unknown';
    otherOperationShippedQuantity: string;
  };
  inventory_mismatch: Common & {
    connectionIds: [string, string];
    canonicalLocationId: string;
    leftAvailable: string | null;
    rightAvailable: string | null;
    leftUnit: string;
    rightUnit: string;
    leftObservedAt: string;
    rightObservedAt: string;
    leftBasis: 'provider_reported' | 'derived' | 'unknown';
    rightBasis: 'provider_reported' | 'derived' | 'unknown';
    mappedSku: boolean;
    equivalentPool: boolean;
    complete: boolean;
    projectionCurrent: boolean;
    authority: 'left' | 'right' | null;
    /** Shared workspace authority; absent on legacy observations. */
    authorityState?: 'resolved' | 'unknown' | 'conflicting';
    sellingSource: 'left' | 'right';
    tolerance: string;
    /**
     * Luma observation time of the first report that disagreed after both sides last agreed
     * within tolerance; null when no agreement is recorded. Absent on legacy input.
     */
    mismatchSince?: string | null;
    /**
     * An open stock sync stall case covers this pair, so a gap that doesn't oversell waits for
     * the sync instead of opening its own case. Absent on earlier input.
     */
    syncStalled?: boolean;
  };
  order_quantity_mismatch: Common & {
    /** Canonical line ID, or a mapped SKU that occurs once per source, as comparisons match lines. */
    lineKey: string;
    /** Every current source connection of the order. */
    connectionIds: string[];
    /** Workspace order-line authority when the sources were read. */
    authorityState: 'resolved' | 'unknown' | 'conflicting';
    authorityConnectionId: string | null;
    /** Each source's current units of the line; null when the source does not report them. */
    quantities: { connectionId: string; quantity: string | null }[];
    unit: string;
    /** Lines match unambiguously and no contributing collection read failed or was partial. */
    complete: boolean;
    /** Latest observed business-state change of any source, on Luma's clock. */
    changedAt: string;
    /** Oldest and newest contributing order and fulfillment reads, on Luma's clock. */
    oldestReadAt: string;
    latestReadAt: string;
  };
  stock_sync_stall: Common & {
    /** The stock authority's connection, then the storefront connection that should follow it. */
    connectionIds: [string, string];
    /**
     * Linked positions whose authority stock changed at least the stall window ago and that the
     * storefront still doesn't match, from stored reports.
     */
    lagging: number;
    /** Linked positions whose authority stock changed in the same window and that the storefront matches. */
    followed: number;
    /** Lagging positions reread from both sources for this evaluation. */
    sampled: number;
    /** Reread positions that still differ. */
    confirmed: number;
    /** Reread positions where the storefront shows more stock than the authority. */
    overselling: number;
    /** When Luma first saw the earliest unfollowed authority change; null without lagging positions. */
    laggingSince: string | null;
    /** Oldest and newest reread; null when nothing was reread. */
    oldestReadAt: string | null;
    latestReadAt: string | null;
    /**
     * Both connections' stock reads completed after the earliest unfollowed change and none are
     * failing, so a missing storefront update is not Luma's own gap.
     */
    readsCurrent: boolean;
  };
  workflow_failure: Common & {
    runId: string;
    stepKey: string;
    attempt: number;
    status:
      | 'failed'
      | 'timed_out'
      | 'running'
      | 'succeeded'
      | 'cancelled'
      | 'interrupted';
    durable: boolean;
    retryExhausted: boolean;
    effect: 'none' | 'unknown';
    executionId: string | null;
    errorCode: string;
  };
}

export type ExceptionClass = keyof FactMap;

export type Facts<K extends ExceptionClass = ExceptionClass> = FactMap[K];

export type EvaluationInput = {
  [K in ExceptionClass]: { exceptionClass: K; facts: Facts<K> };
}[ExceptionClass];

export type Decision =
  | { decision: 'detect'; severity: 'medium' | 'high'; reason: string }
  | { decision: 'clear' | 'defer' | 'reject'; severity: null; reason: string };

export const defaultConfiguration: Configuration = {
  version: 'v0.4',
  ruleVersion: 'v0.2',
  inventoryTolerance: '0',
  thresholds: {
    freshnessSeconds: 300,
    pairSkewSeconds: 60,
    syncFailureSeconds: 900,
    stuckSeconds: 7200,
    uncertaintySeconds: 1800,
    propagationSeconds: 1800,
    oversellPropagationSeconds: 120,
    oversellGuardPercent: 25,
    stallSeconds: 900,
    stallMinPositions: 3,
    stallSharePercent: 50,
  },
};

/** Stall thresholds, with defaults for configurations stored before they existed. */
export function stallThresholds(thresholds: Configuration['thresholds']) {
  return {
    seconds: thresholds.stallSeconds ?? 900,
    minPositions: thresholds.stallMinPositions ?? 3,
    sharePercent: thresholds.stallSharePercent ?? 50,
  };
}

/**
 * Whether enough recent authority changes are unfollowed to suspect a stalled stock sync: at
 * least the minimum number of products, and at least the configured share of changed products.
 */
export function stallSuspected(
  counts: { lagging: number; followed: number },
  thresholds: Configuration['thresholds'],
) {
  const stall = stallThresholds(thresholds);

  return (
    counts.lagging >= stall.minPositions &&
    counts.lagging * 100 >=
      stall.sharePercent * (counts.lagging + counts.followed)
  );
}

/** Scale decimals to millionths without rounding through floating point. */
export function decimalUnits(value: string): bigint {
  if (!/^-?\d{1,14}(?:\.\d{1,6})?$/.test(value))
    throw new Error('Invalid decimal quantity');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const units = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));

  return negative ? -units : units;
}

/** Formats millionth-unit integers as decimal strings without floating-point rounding. */
export function decimalString(value: bigint): string {
  const magnitude = value < 0n ? -value : value;

  return `${value < 0n ? '-' : ''}${magnitude / 1_000_000n}.${String(magnitude % 1_000_000n).padStart(6, '0')}`;
}

/** Selects the confirmation window from the direction of a comparable stock difference. */
export function inventoryPropagationSeconds(
  facts: Facts<'inventory_mismatch'>,
  thresholds: Configuration['thresholds'],
) {
  const difference =
    decimalUnits(facts.leftAvailable ?? '0') -
    decimalUnits(facts.rightAvailable ?? '0');
  const oversell =
    facts.authority !== null &&
    facts.authority !== facts.sellingSource &&
    (facts.sellingSource === 'left' ? difference > 0n : difference < 0n);

  return oversell
    ? (thresholds.oversellPropagationSeconds ?? thresholds.propagationSeconds)
    : thresholds.propagationSeconds;
}
