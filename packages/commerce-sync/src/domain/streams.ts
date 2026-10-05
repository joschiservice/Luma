export const recordTypes = [
  'orders',
  'fulfillments',
  'products',
  'inventory',
  'customers',
  'returns',
] as const;

export type RecordType = (typeof recordTypes)[number];

/** The read capability that supplies each record type. */
export const recordCapabilities = {
  orders: 'orders.read',
  fulfillments: 'fulfillment.read',
  products: 'products.read',
  inventory: 'inventory.read',
  customers: 'customers.read',
  returns: 'returns.read',
} as const satisfies Record<RecordType, `${string}.read`>;

/** Record types that refer to orders; their history import waits for the order history. */
export const orderChildren: readonly RecordType[] = ['fulfillments', 'returns'];

/** Returns the record type a read capability supplies, or null for other reads. */
export function recordTypeFor(capability: string): RecordType | null {
  return (
    recordTypes.find((type) => recordCapabilities[type] === capability) ?? null
  );
}

/**
 * `backfill` reads the source's complete history once; `incremental` reads records changed
 * since the last scan; `reconcile` rereads everything to find missed or removed records.
 */
export type ScanKind = 'backfill' | 'incremental' | 'reconcile';

export type ScanTrigger = 'connection' | 'operator' | 'schedule' | 'webhook';

export type BlockReason =
  'connection_inactive' | 'principal_unavailable' | 'capability_removed';

/** Durable sync state for one connection and record type. */
export interface SyncStream {
  id: string;
  tenantId: string;
  connectionId: string;
  recordType: RecordType;
  /** The person whose current permissions every read and import runs with. */
  principalId: string;
  paused: boolean;
  /** `backfill` until the first complete history scan finishes. */
  phase: 'backfill' | 'incremental';
  scan: {
    id: string;
    kind: ScanKind;
    /** Opaque provider cursor of the next page; null before the first page. */
    cursor: string | null;
    startedAt: string;
    since: string | null;
    pages: number;
    records: number;
    total: number | null;
  } | null;
  fullRequested: boolean;
  /** Start of the last completed scan; the next incremental read starts shortly before it. */
  watermark: string | null;
  /** Earliest creation time the source allowed when the history import started. */
  historyFrom: string | null;
  historyRequirement: string | null;
  /** Whether the source still limited history on the latest scan. */
  currentHistoryLimited: boolean;
  dueAt: string | null;
  hintAt: string | null;
  attempts: number;
  error: { code: string; message: string; at: string } | null;
  /** When the current run of consecutive failures began; null after a successful page. */
  failingSince: string | null;
  blocked: BlockReason | null;
  lastSuccessAt: string | null;
  lastCompleteAt: string | null;
  lastFullScanAt: string | null;
  backfillStartedAt: string | null;
  backfillCompletedAt: string | null;
  version: number;
}

export const syncPolicy = {
  pageSize: 25,
  leaseMs: 5 * 60_000,
  /** Interval between change reads when the source filters by update time. */
  incrementalIntervalMs: 5 * 60_000,
  /** Interval between full rereads when the source cannot filter by update time. */
  pollIntervalMs: 30 * 60_000,
  fullScanIntervalMs: 24 * 60 * 60_000,
  /** Change notifications are batched briefly before a read starts. */
  hintDelayMs: 10_000,
  /** Incremental reads overlap the previous scan to tolerate clock skew and late commits. */
  overlapMs: 10 * 60_000,
  firstRetryDelayMs: 30_000,
  maxRetryDelayMs: 60 * 60_000,
  /** Consecutive failures after which a retrying stream is reported as failing. */
  failingAfterAttempts: 5,
} as const;

export interface ScanPlan {
  kind: ScanKind;
  /** Source update time the read filters from; null reads every record. */
  since: string | null;
  trigger: ScanTrigger;
}

/**
 * Chooses the scan a claimed stream starts when it has none in progress. History comes
 * first; a requested or overdue full reread comes next; otherwise changed records are read.
 * Sources that cannot filter by update time are reread in full each time.
 */
export function planScan(
  stream: Pick<
    SyncStream,
    | 'phase'
    | 'fullRequested'
    | 'lastFullScanAt'
    | 'watermark'
    | 'hintAt'
    | 'backfillStartedAt'
  >,
  now: Date,
  supportsSince: boolean,
): ScanPlan {
  const hinted = stream.hintAt !== null && Date.parse(stream.hintAt) <= +now;
  if (stream.phase === 'backfill')
    return {
      kind: 'backfill',
      since: null,
      trigger: stream.fullRequested ? 'operator' : 'connection',
    };
  if (
    stream.fullRequested ||
    !stream.lastFullScanAt ||
    +now - Date.parse(stream.lastFullScanAt) >= syncPolicy.fullScanIntervalMs
  )
    return {
      kind: 'reconcile',
      since: null,
      trigger: stream.fullRequested ? 'operator' : 'schedule',
    };

  return {
    kind: 'incremental',
    since:
      supportsSince && stream.watermark
        ? new Date(
            Date.parse(stream.watermark) - syncPolicy.overlapMs,
          ).toISOString()
        : null,
    trigger: hinted ? 'webhook' : 'schedule',
  };
}

/** When the next change read is due after a completed scan. */
export function nextDueAt(now: Date, supportsSince: boolean) {
  return new Date(
    +now +
      (supportsSince
        ? syncPolicy.incrementalIntervalMs
        : syncPolicy.pollIntervalMs),
  ).toISOString();
}

/**
 * Exponential retry delay for the given consecutive failure count, never shorter than the
 * source's advice and never longer than an hour.
 */
export function retryDelayMs(attempts: number, advisedMs?: number) {
  const exponential =
    syncPolicy.firstRetryDelayMs * 2 ** Math.max(0, attempts - 1);

  return Math.min(
    syncPolicy.maxRetryDelayMs,
    Math.max(exponential, advisedMs ?? 0),
  );
}

const failureMessages: Record<string, string> & { default: string } = {
  authentication:
    'The source rejected Luma’s credentials. Reconnect this connection.',
  permission_denied:
    'The source denied access to these records. Check the granted permissions and reconnect.',
  rate_limited:
    'The source asked Luma to slow down. Luma retries automatically.',
  timeout: 'The source did not respond in time. Luma retries automatically.',
  transient:
    'The source was temporarily unavailable. Luma retries automatically.',
  unavailable:
    'The connection is unavailable. Luma retries when it is active again.',
  invalid_response:
    'The source returned records Luma could not read. Luma retries automatically; contact support if this continues.',
  default:
    'Luma could not complete this sync step. It retries automatically; contact support if this continues.',
};

/** A controlled, user-facing explanation for a failed page read. */
export function failureMessage(code: string) {
  return Object.hasOwn(failureMessages, code)
    ? failureMessages[code]!
    : failureMessages.default;
}

export type StreamStatus =
  | 'paused'
  | 'blocked'
  | 'failing'
  | 'retrying'
  | 'waiting'
  | 'importing'
  | 'syncing'
  | 'up_to_date';

/**
 * Where a stream stands for people: paused and blocked streams need someone; retrying
 * streams recover on their own until repeated failures make them failing.
 */
export function streamStatus(
  stream: Pick<
    SyncStream,
    'paused' | 'blocked' | 'error' | 'attempts' | 'phase' | 'scan'
  >,
  waitingOnOrders = false,
): StreamStatus {
  if (stream.paused) return 'paused';
  if (stream.blocked) return 'blocked';
  if (stream.error)
    return stream.attempts >= syncPolicy.failingAfterAttempts
      ? 'failing'
      : 'retrying';
  if (stream.phase === 'backfill')
    return waitingOnOrders && !stream.scan ? 'waiting' : 'importing';
  if (stream.scan) return 'syncing';

  return 'up_to_date';
}

/**
 * The creation-date window Luma can hold for a stream. A history limit applies from the
 * import that ran under it; when the source later stops limiting history, a re-import can
 * add older records.
 */
export function historyWindow(
  stream: Pick<
    SyncStream,
    'historyFrom' | 'historyRequirement' | 'currentHistoryLimited' | 'phase'
  >,
) {
  return {
    from: stream.historyFrom,
    requirement: stream.historyRequirement,
    olderHistoryAvailable:
      stream.historyFrom !== null &&
      stream.phase === 'incremental' &&
      !stream.currentHistoryLimited,
  };
}
