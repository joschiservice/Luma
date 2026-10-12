/** Comparison defaults use elapsed time and Luma observation times, never provider clocks. */
export const orderComparisonPolicy = {
  graceSeconds: 900,
  freshnessSeconds: 300,
};

export type ComparisonState =
  'matching' | 'pending' | 'confirmed' | 'inconclusive';

export type ComparisonField =
  | 'status'
  | 'paymentStatus'
  | 'total'
  | 'lines'
  | 'orderedQuantity'
  | 'currentQuantity'
  | 'cancelledQuantity'
  | 'fulfilledQuantity'
  | 'remainingQuantity'
  | 'fulfillment'
  | 'location'
  | 'overfulfillment'
  | 'unit';

/** Immutable reads supporting a source value; times are measured on Luma's clock. */
interface ComparisonEvidence {
  snapshotId: string;
  observationId: string;
  observedAt: string;
}

export interface ComparisonLine {
  id: string;
  skuId: string | null;
  quantity: string;
  currentQuantity?: string | null;
  cancelledQuantity: string | null;
  unit: string;
}

export interface ComparisonFulfillment extends ComparisonEvidence {
  deleted?: boolean;
  status: string;
  kind?: string | null;
  location?: { locationId: string | null } | null;
  lines: {
    orderLineId: string;
    quantity: string;
    remainingQuantity?: string | null;
  }[];
}

/** One fulfillment record's business facts, without its evidence references. */
export type FulfillmentFacts = Omit<
  ComparisonFulfillment,
  keyof ComparisonEvidence
>;

/** The business facts of one source report that comparisons read. */
export interface SourceFacts {
  status: string;
  paymentStatus: string;
  total?: { amount: string; currency: string } | null;
  lines: ComparisonLine[];
  fulfillments: FulfillmentFacts[];
}

export interface ComparisonSource extends ComparisonEvidence {
  connectionId: string;
  status: string;
  paymentStatus: string;
  total?: { amount: string; currency: string } | null;
  lines: ComparisonLine[];
  fulfillments: ComparisonFulfillment[];
}

export interface ComparisonDifference {
  field: ComparisonField;
  /** Canonical line ID or unambiguous mapped SKU ID; null for order facts. */
  lineKey: string | null;
  values: {
    connectionId: string;
    value: string | null;
    evidence: ComparisonEvidence[];
  }[];
}

type LineFacts = Record<
  Exclude<ComparisonField, 'status' | 'paymentStatus' | 'total' | 'lines'>,
  string | null
>;

const scale = 1_000_000n;

function units(value: string) {
  const [whole = '0', fraction = ''] = value.split('.');

  return BigInt(whole) * scale + BigInt(fraction.padEnd(6, '0'));
}

function decimal(value: bigint) {
  return `${value / scale}${
    value % scale
      ? `.${String(value % scale)
          .padStart(6, '0')
          .replace(/0+$/, '')}`
      : ''
  }`;
}

const known = (value: string) => (value === 'unknown' ? null : value);

function lineFacts(
  line: ComparisonLine,
  fulfillments: FulfillmentFacts[],
): LineFacts {
  const current =
    line.currentQuantity != null
      ? units(line.currentQuantity)
      : line.cancelledQuantity != null
        ? units(line.quantity) - units(line.cancelledQuantity)
        : null;
  const shipments = fulfillments.filter(
    (item) =>
      !item.deleted &&
      item.kind !== 'fulfillment_order' &&
      ['shipped', 'delivered', 'completed'].includes(item.status),
  );
  const fulfilled = shipments.reduce(
    (sum, item) =>
      sum +
      item.lines
        .filter((l) => l.orderLineId === line.id)
        .reduce((sum, l) => sum + units(l.quantity), 0n),
    0n,
  );
  const remaining =
    current === null ? null : current > fulfilled ? current - fulfilled : 0n;
  const allocations = new Map<string, bigint>();
  let unknownLocation = false;
  for (const item of fulfillments) {
    if (
      item.deleted ||
      item.status === 'cancelled' ||
      (item.kind !== 'fulfillment_order' && !shipments.includes(item))
    )
      continue;
    for (const l of item.lines.filter((l) => l.orderLineId === line.id)) {
      const quantity =
        item.kind === 'fulfillment_order'
          ? l.remainingQuantity == null
            ? null
            : units(l.remainingQuantity)
          : units(l.quantity);
      if (quantity === 0n) continue;
      const location = item.location?.locationId;
      if (!location || quantity === null) {
        unknownLocation = true;
        continue;
      }
      allocations.set(location, (allocations.get(location) ?? 0n) + quantity);
    }
  }

  return {
    unit: line.unit,
    orderedQuantity: decimal(units(line.quantity)),
    currentQuantity: current === null ? null : decimal(current),
    cancelledQuantity:
      line.cancelledQuantity == null
        ? null
        : decimal(units(line.cancelledQuantity)),
    fulfilledQuantity: decimal(fulfilled),
    remainingQuantity: remaining === null ? null : decimal(remaining),
    fulfillment:
      current === null
        ? null
        : fulfilled > 0n
          ? remaining === 0n
            ? 'fulfilled'
            : 'partial'
          : current === 0n
            ? 'not_required'
            : 'unfulfilled',
    location:
      unknownLocation || !allocations.size
        ? null
        : JSON.stringify(
            [...allocations]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([id, quantity]) => [id, decimal(quantity)]),
          ),
    overfulfillment:
      current !== null && fulfilled > current
        ? decimal(fulfilled - current)
        : null,
  };
}

/** Normalizes exact quantities and mapped line identities without summing repeated SKU lines. */
export function comparisonFacts(source: SourceFacts, sharedLines: Set<string>) {
  const skuCounts = new Map<string, number>();
  for (const line of source.lines)
    if (line.skuId)
      skuCounts.set(line.skuId, (skuCounts.get(line.skuId) ?? 0) + 1);
  let incomplete = false;
  const lines = source.lines
    .map((line) => {
      const key = sharedLines.has(line.id)
        ? line.id
        : line.skuId && skuCounts.get(line.skuId) === 1
          ? line.skuId
          : null;
      if (!key) incomplete = true;
      if (
        source.fulfillments.some(
          (item) =>
            !item.deleted &&
            item.status === 'unknown' &&
            item.lines.some((l) => l.orderLineId === line.id),
        )
      )
        incomplete = true;

      return { key, lineId: line.id, ...lineFacts(line, source.fulfillments) };
    })
    .sort((a, b) => (a.key ?? a.lineId).localeCompare(b.key ?? b.lineId));

  return {
    status: known(source.status),
    paymentStatus: known(source.paymentStatus),
    total: source.total
      ? `${source.total.amount.includes('.') ? source.total.amount.replace(/0+$/, '').replace(/\.$/, '') : source.total.amount} ${source.total.currency}`
      : null,
    lines,
    incomplete,
  };
}

/** Finds line IDs explicitly shared by different source reports of the same linked order. */
export function sharedComparisonLines(
  sources: Pick<ComparisonSource, 'connectionId' | 'lines'>[],
) {
  const connections = new Map<string, Set<string>>();
  for (const source of sources)
    for (const line of source.lines) {
      const seen = connections.get(line.id) ?? new Set<string>();
      seen.add(source.connectionId);
      connections.set(line.id, seen);
    }

  return new Set(
    [...connections].filter(([, seen]) => seen.size > 1).map(([id]) => id),
  );
}

/** Compares known business facts, preserving each source's immutable evidence and unknowns. */
export function compareOrderSources(sources: ComparisonSource[]) {
  const shared = sharedComparisonLines(sources);
  const facts = sources.map((source) => ({
    source,
    facts: comparisonFacts(source, shared),
  }));
  const differences: ComparisonDifference[] = [];
  const add = (
    field: ComparisonField,
    lineKey: string | null,
    values: (string | null)[],
    force = false,
  ) => {
    if (!force && new Set(values.filter((value) => value !== null)).size < 2)
      return;
    differences.push({
      field,
      lineKey,
      values: sources.map((source, index) => ({
        connectionId: source.connectionId,
        value: values[index] ?? null,
        evidence: [
          {
            snapshotId: source.snapshotId,
            observationId: source.observationId,
            observedAt: source.observedAt,
          },
          ...source.fulfillments.map(
            ({ snapshotId, observationId, observedAt }) => ({
              snapshotId,
              observationId,
              observedAt,
            }),
          ),
        ],
      })),
    });
  };
  for (const field of ['status', 'paymentStatus', 'total'] as const)
    add(
      field,
      null,
      facts.map((item) => item.facts[field]),
    );
  const keys = new Set(
    facts.flatMap((item) =>
      item.facts.lines.flatMap((line) => (line.key ? [line.key] : [])),
    ),
  );
  for (const key of keys) {
    const lines = facts.map((item) =>
      item.facts.lines.find((line) => line.key === key),
    );
    for (const field of [
      'orderedQuantity',
      'currentQuantity',
      'cancelledQuantity',
      'fulfilledQuantity',
      'remainingQuantity',
      'fulfillment',
      'location',
      'unit',
    ] as const) {
      add(
        field,
        key,
        lines.map((line) =>
          line ? line[field] : field === 'currentQuantity' ? '0' : null,
        ),
      );
    }
    add(
      'overfulfillment',
      key,
      lines.map((line) => line?.overfulfillment ?? null),
      lines.some((line) => line?.overfulfillment != null),
    );
  }
  for (const item of facts)
    for (const line of item.facts.lines)
      if (!line.key && line.overfulfillment !== null) {
        add(
          'overfulfillment',
          line.lineId,
          facts.map((candidate) =>
            candidate === item ? line.overfulfillment : null,
          ),
          true,
        );
      }

  return {
    differences,
    incomplete:
      sources.length > 1 && facts.some((item) => item.facts.incomplete),
  };
}

/** Applies freshness before grace; confirmation requires rereads after the entire propagation window. */
export function orderComparisonState(
  raw: 'matching' | 'different' | 'inconclusive',
  readAt: string | null,
  latestReadAt: string | null,
  confirmAfter: string | null,
  asOf: string,
): ComparisonState {
  if (!readAt || !latestReadAt)
    return raw === 'matching' ? 'matching' : 'inconclusive';
  if (
    Date.parse(latestReadAt) > Date.parse(asOf) ||
    Date.parse(asOf) - Date.parse(readAt) >
      orderComparisonPolicy.freshnessSeconds * 1000 ||
    raw === 'inconclusive'
  )
    return 'inconclusive';
  if (raw === 'matching') return 'matching';

  return confirmAfter && Date.parse(readAt) >= Date.parse(confirmAfter)
    ? 'confirmed'
    : 'pending';
}
