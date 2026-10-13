import { fromUnits, toUnits } from './returns.js';
import {
  type ComparisonDifference,
  comparisonFacts,
  type ComparisonLine,
  type ComparisonState,
  type FulfillmentFacts,
  orderComparisonPolicy,
  sharedComparisonLines,
} from './source-comparison.js';

const orderChangeKinds = [
  'quantity',
  'item',
  'address',
  'location',
  'cancellation',
] as const;

/**
 * What changes: a line's current units, a line added or removed, the delivery address, the
 * location assigned to fulfil, or the whole order's cancellation.
 */
export type OrderChangeKind = (typeof orderChangeKinds)[number];

type AuthorityGroup =
  'order_lines' | 'order_lifecycle' | 'order_fulfillment' | 'order_tracking';

/** The workspace authority of one order fact group, as the authority reader resolved it. */
export interface PlanAuthority {
  group: AuthorityGroup;
  state: 'resolved' | 'unknown' | 'conflicting';
  connectionId: string | null;
}

/**
 * Provider write capabilities that change orders. A Luma step exists only for a change kind a
 * capability covers; every other step is for a person. `authority` names the fact group the
 * target connection must hold, as the capability's own preview requires; `wholeUnits` means
 * the provider accepts only whole quantities.
 */
export const orderChangeCapabilities = [
  {
    capability: 'orders.quantity.edit',
    kinds: ['quantity', 'item'] as OrderChangeKind[],
    authority: 'order_lines' as AuthorityGroup,
    wholeUnits: true,
  },
] as const;

/** One source connection's report of the order, its fulfilment records and what Luma may do there. */
export interface PlanSource {
  connectionId: string;
  deleted: boolean;
  /** When Luma read the order, on Luma's clock. */
  observedAt: string;
  status: string;
  lines: (ComparisonLine & {
    skuCode?: string | null;
    title?: string | null;
  })[];
  /** Every current fulfilment record of this source, including removed ones. */
  fulfillments: (FulfillmentFacts & { observedAt: string })[];
  /**
   * The latest order or fulfilment collection read of this connection since the order's oldest
   * contributing read failed, was partial or left pagination unfinished.
   */
  incompleteRead: boolean;
  /** The source order ID, used to hand a Luma step to the provider's action. */
  externalId: string | null;
  /** Source line IDs by canonical line ID, for lines with exactly one mapping. */
  lineRefs: Record<string, string>;
  connection: {
    category: 'storefront' | 'erp' | null;
    available: boolean;
    /** Granted installation capabilities. */
    capabilities: string[];
    writeMode: 'observe_only' | 'writes_enabled';
    /**
     * The app permission a person needs to request each governed write capability through this
     * connection's app, and whether the current reader holds it. Absent capabilities have no
     * Luma action through this connection.
     */
    access: Record<string, { permission: string; viewerHas: boolean }>;
  };
}

/** A change an operator proposes, or null to plan the differences comparison detected. */
export type OrderChangeRequest =
  | { kind: 'quantity'; lineKey: string; quantity: string }
  | { kind: 'item'; lineKey: string }
  | { kind: 'location'; lineKey: string | null }
  | { kind: 'cancellation' }
  | { kind: 'address' };

export interface OrderChangePlanInput {
  sources: PlanSource[];
  /** False when the reader may not see fulfilments; fulfilment facts are then empty. */
  fulfillmentsVisible: boolean;
  authority: PlanAuthority[];
  /** Maintained comparison differences and their read-time state. */
  differences: ComparisonDifference[];
  comparisonState: ComparisonState;
  asOf: string;
  request: OrderChangeRequest | null;
}

type SafetyReasonCode =
  | 'work_started'
  | 'shipped'
  | 'fulfilled_beyond_target'
  | 'cancelled'
  | 'closed'
  | 'stale_evidence'
  | 'incomplete_evidence'
  | 'ambiguous_line'
  | 'unknown_progress'
  | 'unknown_value'
  | 'authority_unknown'
  | 'authority_conflict'
  | 'no_fulfilment_source'
  | 'fulfilment_hidden';

const unsafeCodes = new Set<SafetyReasonCode>([
  'work_started',
  'shipped',
  'fulfilled_beyond_target',
  'cancelled',
  'closed',
]);

interface SafetyReason {
  code: SafetyReasonCode;
  connectionId: string | null;
  lineKey: string | null;
}

type StepKind =
  | 'confirm'
  | 'request_hold'
  | 'reassign_work'
  | 'update_record'
  | 'notify'
  | 'escalate';

/** What one step asks for; interfaces translate these codes. */
type StepAction =
  | 'check_progress'
  | 'confirm_picking'
  | 'stop_work'
  | 'hold_for_address'
  | 'stop_and_reassign'
  | 'return_or_refund'
  | 'update_quantity'
  | 'cancel_order'
  | 'update_address'
  | 'reassign_location'
  | 'carrier_redirect'
  | 'notify_added_units'
  | 'notify_customer'
  | 'escalate_unsafe'
  | 'escalate_unknown';

/** Why a Luma step cannot run now. */
type StepBlock =
  | 'not_granted'
  | 'unavailable'
  | 'authority'
  | 'unmapped'
  | 'whole_units'
  | 'observe_only'
  | 'unsafe'
  | 'unknown';

interface PlanStep {
  id: string;
  kind: StepKind;
  action: StepAction;
  performer: 'luma' | 'person';
  /** Who does a person step. */
  role: 'warehouse' | 'carrier' | 'finance' | 'operator' | null;
  /** The system the step changes or concerns; null when it is not one connection. */
  connectionId: string | null;
  capability: string | null;
  /** True only for a Luma step whose capability, controls and safety all allow it now. */
  executable: boolean;
  blockedBy: StepBlock | null;
  /** App permission a person needs to request the Luma step. */
  permission: string | null;
  viewerCanRequest: boolean;
  /** Exact source references the provider action needs, when every one is mapped. */
  handoff: {
    orderExternalId: string;
    lines: { externalId: string; quantity: string }[];
  } | null;
}

interface ShippedLine {
  lineKey: string;
  /** Shipped units counted once; null when no visible fulfilment source reports the line. */
  units: string | null;
  unit: string | null;
  /** Fulfilment authority's report, else the largest report of any source; never a sum. */
  basis: 'authority' | 'maximum' | 'unknown';
  connectionId: string | null;
  sources: { connectionId: string; units: string }[];
}

export interface OrderChangePlan {
  change: {
    kind: OrderChangeKind;
    origin: 'detected' | 'proposed';
    lineKey: string | null;
    line: { skuCode: string | null; title: string | null } | null;
    /** The current value: the authoritative one for proposals, a differing one for detections. */
    from: string | null;
    /** The intended value; null when no authoritative source reports it. */
    to: string | null;
    unit: string | null;
  };
  acknowledgements: {
    connectionId: string;
    state: 'reflects' | 'differs' | 'unknown';
    value: string | null;
    readAt: string;
    fresh: boolean;
  }[];
  shipped: ShippedLine[];
  safety: { state: 'safe' | 'unsafe' | 'unknown'; reasons: SafetyReason[] };
  steps: PlanStep[];
}

/** A requested line or value that is not on this order. */
export class OrderChangeRequestError extends Error {
  constructor(readonly code: 'unknown_line' | 'invalid_quantity') {
    super(code);
  }
}

const startedStatuses = new Set(['processing', 'failed']);
const shippedStatuses = new Set(['shipped', 'delivered', 'completed']);

type Facts = ReturnType<typeof comparisonFacts>;

interface Evaluated {
  source: PlanSource;
  facts: Facts;
  fresh: boolean;
  /** The source reads fulfilments and the reader may see them. */
  reportsFulfilment: boolean;
}

function decimal(value: string | null) {
  return value === null ? null : fromUnits(toUnits(value));
}

/** Source-local line IDs of `key`, or every line when the change concerns the whole order. */
function linesFor(item: Evaluated, key: string | null) {
  return item.facts.lines
    .filter((line) => key === null || line.key === key)
    .map((line) => line.lineId);
}

/** Reports whether any live fulfilment record of the source has started on these lines. */
function workStarted(item: Evaluated, lineIds: string[]) {
  return item.source.fulfillments.some(
    (work) =>
      !work.deleted &&
      (startedStatuses.has(work.status) ||
        (work.kind !== 'fulfillment_order' &&
          shippedStatuses.has(work.status))) &&
      work.lines.some(
        (line) =>
          lineIds.includes(line.orderLineId) && toUnits(line.quantity) > 0n,
      ),
  );
}

function unknownStatus(item: Evaluated, lineIds: string[]) {
  return item.source.fulfillments.some(
    (work) =>
      !work.deleted &&
      work.status === 'unknown' &&
      work.lines.some((line) => lineIds.includes(line.orderLineId)),
  );
}

/** Shipped units of one source over the given lines, summed within the source only. */
function shippedUnits(item: Evaluated, key: string | null) {
  return item.facts.lines
    .filter((line) => key === null || line.key === key)
    .reduce((sum, line) => sum + toUnits(line.fulfilledQuantity ?? '0'), 0n);
}

function isFresh(source: PlanSource, asOf: string) {
  const now = Date.parse(asOf);
  const reads = [
    source.observedAt,
    ...source.fulfillments.map((work) => work.observedAt),
  ].map(Date.parse);

  return reads.every(
    (read) =>
      read <= now &&
      now - read <= orderComparisonPolicy.freshnessSeconds * 1000,
  );
}

/**
 * The shipped view of one line: the fulfilment authority's count when it reports the line,
 * otherwise the largest count any source reports. Mirrored shipments are never added.
 */
function shippedLine(
  key: string,
  items: Evaluated[],
  authority: PlanAuthority | undefined,
): ShippedLine {
  const reporting = items.filter(
    (item) =>
      item.reportsFulfilment &&
      item.facts.lines.some((line) => line.key === key),
  );
  const sources = reporting.map((item) => ({
    connectionId: item.source.connectionId,
    units: fromUnits(shippedUnits(item, key)),
  }));
  const unit =
    reporting
      .flatMap((item) => item.facts.lines)
      .find((line) => line.key === key)?.unit ?? null;
  const authoritative =
    authority?.state === 'resolved'
      ? sources.find((item) => item.connectionId === authority.connectionId)
      : undefined;
  if (authoritative)
    return {
      lineKey: key,
      units: authoritative.units,
      unit,
      basis: 'authority',
      connectionId: authoritative.connectionId,
      sources,
    };
  if (!sources.length)
    return {
      lineKey: key,
      units: null,
      unit,
      basis: 'unknown',
      connectionId: null,
      sources,
    };
  const largest = sources.reduce((a, b) =>
    toUnits(b.units) > toUnits(a.units) ? b : a,
  );

  return {
    lineKey: key,
    units: largest.units,
    unit,
    basis: 'maximum',
    connectionId: largest.connectionId,
    sources,
  };
}

/** A source's value of the changed fact, or null when it is not known. */
function sourceValue(
  item: Evaluated,
  kind: OrderChangeKind,
  key: string | null,
): string | null {
  if (kind === 'cancellation')
    return item.source.status === 'unknown' ? null : item.source.status;
  if (kind === 'address') return null;
  const line = item.facts.lines.find((candidate) => candidate.key === key);
  if (kind === 'location') return line?.location ?? null;
  if (line) return line.currentQuantity;

  // A complete report without the line has none of it, as comparisons treat it.
  return item.facts.lines.every((candidate) => candidate.key) ? '0' : null;
}

function sameValue(kind: OrderChangeKind, a: string, b: string) {
  return kind === 'quantity' || kind === 'item'
    ? toUnits(a) === toUnits(b)
    : a === b;
}

/** Changes the maintained comparison found, once differences are confirmed or pending. */
function detectedChanges(
  input: OrderChangePlanInput,
): { kind: OrderChangeKind; lineKey: string | null }[] {
  if (!['confirmed', 'pending'].includes(input.comparisonState)) return [];
  const found = new Map<
    string,
    { kind: OrderChangeKind; lineKey: string | null }
  >();
  const add = (kind: OrderChangeKind, lineKey: string | null) =>
    found.set(`${kind}:${lineKey ?? ''}`, { kind, lineKey });
  for (const difference of input.differences) {
    const values = difference.values.map((value) => value.value);
    if (
      difference.field === 'status' &&
      values.some((value) => value === 'cancelled')
    )
      add('cancellation', null);
    if (difference.field === 'currentQuantity' && difference.lineKey)
      add(
        values.some((value) => value !== null && toUnits(value) === 0n)
          ? 'item'
          : 'quantity',
        difference.lineKey,
      );
    if (difference.field === 'location' && difference.lineKey)
      add('location', difference.lineKey);
  }

  return [...found.values()].sort(
    (a, b) =>
      orderChangeKinds.indexOf(a.kind) - orderChangeKinds.indexOf(b.kind) ||
      (a.lineKey ?? '').localeCompare(b.lineKey ?? ''),
  );
}

const neededAuthority: Record<OrderChangeKind, AuthorityGroup | null> = {
  quantity: 'order_lines',
  item: 'order_lines',
  cancellation: 'order_lifecycle',
  location: 'order_fulfillment',
  address: null,
};

/**
 * Builds one plan: who reflects the change, what has shipped, whether the change is still safe
 * and the ordered steps. Missing, stale or incomplete evidence never yields "safe", and only a
 * safe plan makes a Luma step executable.
 */
function planChange(
  input: OrderChangePlanInput,
  items: Evaluated[],
  change: {
    kind: OrderChangeKind;
    lineKey: string | null;
    target: string | null;
    origin: 'detected' | 'proposed';
  },
): OrderChangePlan {
  const { kind, lineKey } = change;
  const authority = (group: AuthorityGroup | null) =>
    group ? input.authority.find((item) => item.group === group) : undefined;
  const current = items.filter((item) => !item.source.deleted);
  const group = neededAuthority[kind];
  const ruling = authority(group);
  const authoritative = current.find(
    (item) =>
      ruling?.state === 'resolved' &&
      item.source.connectionId === ruling.connectionId,
  );
  const reasons: SafetyReason[] = [];
  const reason = (
    code: SafetyReasonCode,
    connectionId: string | null = null,
    key: string | null = null,
  ) => {
    if (
      !reasons.some(
        (item) =>
          item.code === code &&
          item.connectionId === connectionId &&
          item.lineKey === key,
      )
    )
      reasons.push({ code, connectionId, lineKey: key });
  };

  // The intended value: the proposal, or the authoritative source's value for a detection.
  const authorityValue = authoritative
    ? sourceValue(authoritative, kind, lineKey)
    : null;
  const target =
    change.origin === 'proposed'
      ? kind === 'cancellation'
        ? 'cancelled'
        : kind === 'item'
          ? '0'
          : change.target
      : authorityValue;

  if (group && ruling?.state === 'conflicting') reason('authority_conflict');
  else if (group && !authoritative)
    reason('authority_unknown', ruling?.connectionId ?? null);

  // Evidence the rules depend on.
  for (const item of current) {
    if (!item.fresh) reason('stale_evidence', item.source.connectionId);
    if (item.source.incompleteRead)
      reason('incomplete_evidence', item.source.connectionId);
  }
  if (lineKey && !current.some((item) => linesFor(item, lineKey).length))
    reason('ambiguous_line', null, lineKey);
  if (
    current.length > 1 &&
    current.some((item) => item.facts.lines.some((line) => !line.key))
  )
    reason('ambiguous_line');
  if (!input.fulfillmentsVisible) reason('fulfilment_hidden');
  else if (!current.some((item) => item.reportsFulfilment))
    reason('no_fulfilment_source');

  const scopeKey =
    kind === 'quantity' || kind === 'item' || kind === 'location'
      ? lineKey
      : null;
  const fulfilment = current.filter((item) => item.reportsFulfilment);
  const started = fulfilment.filter((item) =>
    workStarted(item, linesFor(item, scopeKey)),
  );
  for (const item of fulfilment)
    if (unknownStatus(item, linesFor(item, scopeKey)))
      reason('unknown_progress', item.source.connectionId, scopeKey);
  const lineKeys = scopeKey
    ? [scopeKey]
    : [
        ...new Set(
          current.flatMap((item) =>
            item.facts.lines.flatMap((line) => (line.key ? [line.key] : [])),
          ),
        ),
      ].sort();
  const shipped = input.fulfillmentsVisible
    ? lineKeys.map((key) =>
        shippedLine(key, current, authority('order_fulfillment')),
      )
    : [];
  const shippedAny =
    fulfilment.some((item) => shippedUnits(item, scopeKey) > 0n) ||
    shipped.some((line) => line.units !== null && toUnits(line.units) > 0n);

  // What each system shows now.
  const acknowledgements = current.map((item) => {
    const value = sourceValue(item, kind, lineKey);
    const trusted = item.fresh && !item.source.incompleteRead;

    return {
      connectionId: item.source.connectionId,
      state:
        !trusted || value === null || target === null
          ? ('unknown' as const)
          : sameValue(kind, value, target)
            ? ('reflects' as const)
            : ('differs' as const),
      value: kind === 'quantity' || kind === 'item' ? decimal(value) : value,
      readAt: item.source.observedAt,
      fresh: item.fresh,
    };
  });
  const values = current
    .map((item) => sourceValue(item, kind, lineKey))
    .filter((value): value is string => value !== null);
  const quantityChange = kind === 'quantity' || kind === 'item';
  const reduces =
    quantityChange &&
    target !== null &&
    values.some((value) => toUnits(value) > toUnits(target));
  const increases =
    quantityChange &&
    target !== null &&
    values.some((value) => toUnits(value) < toUnits(target));
  // Address changes are not compared, and a proposed reassignment names no location yet.
  const comparable =
    kind !== 'address' &&
    !(change.origin === 'proposed' && kind === 'location');
  if (comparable && target === null) reason('unknown_value', null, lineKey);

  // Kind rules.
  const lifecycle = authority('order_lifecycle');
  const lifecycleSource = current.find(
    (item) =>
      lifecycle?.state === 'resolved' &&
      item.source.connectionId === lifecycle.connectionId,
  );
  if (kind !== 'cancellation' && lifecycleSource) {
    if (lifecycleSource.source.status === 'cancelled')
      reason('cancelled', lifecycleSource.source.connectionId);
    if (lifecycleSource.source.status === 'completed')
      reason('closed', lifecycleSource.source.connectionId);
  }
  const startedReasons = () => {
    for (const item of started)
      reason('work_started', item.source.connectionId, scopeKey);
  };
  if (quantityChange) {
    if (reduces) startedReasons();
    const line = shipped[0];
    if (target !== null && line?.units != null) {
      if (toUnits(line.units) > toUnits(target))
        reason('fulfilled_beyond_target', line.connectionId, lineKey);
    } else if (reduces && line?.units == null)
      reason('unknown_progress', null, lineKey);
  } else {
    startedReasons();
    if (shippedAny) reason('shipped', null, scopeKey);
  }

  const unsafe = reasons.some((item) => unsafeCodes.has(item.code));
  const state: OrderChangePlan['safety']['state'] = unsafe
    ? 'unsafe'
    : reasons.length
      ? 'unknown'
      : 'safe';
  const progressUnknown = reasons.some((item) =>
    [
      'stale_evidence',
      'incomplete_evidence',
      'unknown_progress',
      'no_fulfilment_source',
      'fulfilment_hidden',
    ].includes(item.code),
  );

  const steps = planSteps({
    input,
    kind,
    lineKey,
    target,
    state,
    current,
    started,
    authoritative,
    acknowledgements,
    fulfilmentAuthority: authority('order_fulfillment'),
    reduces,
    increases,
    shippedAny,
    beyondTarget: reasons.some(
      (item) => item.code === 'fulfilled_beyond_target',
    ),
    progressUnknown,
  });
  const labelled = [...(authoritative ? [authoritative] : []), ...current]
    .flatMap((item) => {
      const lineId = item.facts.lines.find(
        (line) => lineKey !== null && line.key === lineKey,
      )?.lineId;
      const line = item.source.lines.find(
        (candidate) => candidate.id === lineId,
      );

      return line ? [line] : [];
    })
    .at(0);
  const unit =
    quantityChange && lineKey
      ? (current
          .flatMap((item) => item.facts.lines)
          .find((line) => line.key === lineKey)?.unit ?? null)
      : null;
  const from =
    change.origin === 'proposed'
      ? authorityValue
      : (current
          .filter((item) => item !== authoritative)
          .map((item) => sourceValue(item, kind, lineKey))
          .find(
            (value) =>
              value !== null &&
              (target === null || !sameValue(kind, value, target)),
          ) ?? null);

  return {
    change: {
      kind,
      origin: change.origin,
      lineKey,
      line: labelled
        ? { skuCode: labelled.skuCode ?? null, title: labelled.title ?? null }
        : null,
      from: quantityChange ? decimal(from) : from,
      to: quantityChange ? decimal(target) : target,
      unit,
    },
    acknowledgements,
    shipped,
    safety: { state, reasons },
    steps,
  };
}

/**
 * Whether authority lets a governed capability change the target connection. The connection may
 * amend its own record when it holds the fact group. When another connection holds it, the
 * change may only propagate that source's value: the target must equal what the authoritative
 * source reports for the same line, read fresh and complete. A stale or incomplete
 * authoritative read is `unknown`; unknown or conflicting authority and any other value are
 * `authority`.
 */
function governedAuthority(
  ruling: PlanAuthority | undefined,
  connectionId: string,
  current: Evaluated[],
  kind: OrderChangeKind,
  lineKey: string | null,
  target: string | null,
): 'authority' | 'unknown' | null {
  if (ruling?.state !== 'resolved' || !ruling.connectionId) return 'authority';
  if (ruling.connectionId === connectionId) return null;
  const holder = current.find(
    (item) => item.source.connectionId === ruling.connectionId,
  );
  const value = holder ? sourceValue(holder, kind, lineKey) : null;
  if (!holder || value === null || target === null) return 'authority';
  if (!sameValue(kind, value, target)) return 'authority';

  return holder.fresh && !holder.source.incompleteRead ? null : 'unknown';
}

function planSteps({
  input,
  kind,
  lineKey,
  target,
  state,
  current,
  started,
  authoritative,
  acknowledgements,
  fulfilmentAuthority,
  reduces,
  increases,
  shippedAny,
  beyondTarget,
  progressUnknown,
}: {
  input: OrderChangePlanInput;
  kind: OrderChangeKind;
  lineKey: string | null;
  target: string | null;
  state: OrderChangePlan['safety']['state'];
  current: Evaluated[];
  started: Evaluated[];
  authoritative: Evaluated | undefined;
  acknowledgements: OrderChangePlan['acknowledgements'];
  fulfilmentAuthority: PlanAuthority | undefined;
  reduces: boolean;
  increases: boolean;
  shippedAny: boolean;
  beyondTarget: boolean;
  progressUnknown: boolean;
}): PlanStep[] {
  const steps: Omit<PlanStep, 'id'>[] = [];
  const person = (
    stepKind: StepKind,
    action: StepAction,
    role: NonNullable<PlanStep['role']>,
    connectionId: string | null,
  ) =>
    steps.push({
      kind: stepKind,
      action,
      performer: 'person',
      role,
      connectionId,
      capability: null,
      executable: false,
      blockedBy: null,
      permission: null,
      viewerCanRequest: false,
      handoff: null,
    });
  const quantityChange = kind === 'quantity' || kind === 'item';
  const fulfilmentSystem =
    current.find(
      (item) =>
        item.reportsFulfilment &&
        fulfilmentAuthority?.state === 'resolved' &&
        item.source.connectionId === fulfilmentAuthority.connectionId,
    ) ?? current.find((item) => item.reportsFulfilment);

  // 1. Stop or confirm work that may be in progress before records change.
  if (started.length && !(quantityChange && !reduces))
    for (const item of started) {
      const id = item.source.connectionId;
      if (quantityChange) person('confirm', 'confirm_picking', 'warehouse', id);
      else if (kind === 'cancellation')
        person('request_hold', 'stop_work', 'warehouse', id);
      else if (kind === 'location')
        person('reassign_work', 'stop_and_reassign', 'warehouse', id);
      else if (!shippedAny)
        person('request_hold', 'hold_for_address', 'warehouse', id);
    }
  else if (progressUnknown && !(quantityChange && !reduces))
    person(
      'confirm',
      'check_progress',
      fulfilmentSystem ? 'warehouse' : 'operator',
      fulfilmentSystem?.source.connectionId ?? null,
    );
  if (kind === 'address' && shippedAny)
    person(
      'update_record',
      'carrier_redirect',
      'carrier',
      fulfilmentSystem?.source.connectionId ?? null,
    );
  if (beyondTarget || (kind === 'cancellation' && shippedAny))
    person('update_record', 'return_or_refund', 'finance', null);

  // 2. Update every system that does not show the change, the authoritative one first.
  const pending = acknowledgements
    .filter((item) => item.state !== 'reflects')
    .sort(
      (a, b) =>
        Number(b.connectionId === authoritative?.source.connectionId) -
        Number(a.connectionId === authoritative?.source.connectionId),
    );
  for (const acknowledgement of pending) {
    const item = current.find(
      (candidate) =>
        candidate.source.connectionId === acknowledgement.connectionId,
    )!;
    const connectionId = item.source.connectionId;
    if (kind === 'cancellation')
      person('update_record', 'cancel_order', 'operator', connectionId);
    else if (kind === 'address')
      person('update_record', 'update_address', 'operator', connectionId);
    else if (kind === 'location')
      person('reassign_work', 'reassign_location', 'operator', connectionId);
    else {
      const governed = orderChangeCapabilities.find(
        (rule) =>
          rule.kinds.includes(kind) &&
          (item.source.connection.access[rule.capability] ||
            item.source.connection.capabilities.includes(rule.capability)),
      );
      if (!governed) {
        person('update_record', 'update_quantity', 'operator', connectionId);
        continue;
      }
      const access = item.source.connection.access[governed.capability];
      const lines =
        lineKey && target !== null
          ? item.facts.lines
              .filter((line) => line.key === lineKey)
              .map((line) => ({
                externalId: item.source.lineRefs[line.lineId] ?? null,
                quantity: fromUnits(toUnits(target)),
              }))
          : [];
      const mapped =
        item.source.externalId &&
        lines.length === 1 &&
        lines.every((line) => line.externalId);
      const authorityBlock = governedAuthority(
        input.authority.find((rule) => rule.group === governed.authority),
        connectionId,
        current,
        kind,
        lineKey,
        target,
      );
      const blockedBy: StepBlock | null =
        !item.source.connection.capabilities.includes(governed.capability)
          ? 'not_granted'
          : !item.source.connection.available
            ? 'unavailable'
            : authorityBlock
              ? authorityBlock
              : !mapped
                ? 'unmapped'
                : governed.wholeUnits &&
                    target !== null &&
                    toUnits(target) % 1_000_000n !== 0n
                  ? 'whole_units'
                  : item.source.connection.writeMode === 'observe_only'
                    ? 'observe_only'
                    : state === 'unsafe'
                      ? 'unsafe'
                      : state === 'unknown'
                        ? 'unknown'
                        : null;
      steps.push({
        kind: 'update_record',
        action: 'update_quantity',
        performer: 'luma',
        role: null,
        connectionId,
        capability: governed.capability,
        executable: blockedBy === null,
        blockedBy,
        permission: access?.permission ?? null,
        viewerCanRequest: access?.viewerHas ?? false,
        handoff: mapped
          ? {
              orderExternalId: item.source.externalId!,
              lines: lines.map((line) => ({
                externalId: line.externalId!,
                quantity: line.quantity,
              })),
            }
          : null,
      });
    }
  }

  // 3. Tell the people affected.
  if (quantityChange && increases && started.length)
    for (const item of started)
      person(
        'notify',
        'notify_added_units',
        'warehouse',
        item.source.connectionId,
      );
  if ((kind === 'address' || kind === 'cancellation') && shippedAny)
    person('notify', 'notify_customer', 'operator', null);

  // 4. Escalate what Luma cannot establish as safe.
  if (state !== 'safe')
    person(
      'escalate',
      state === 'unsafe' ? 'escalate_unsafe' : 'escalate_unknown',
      'operator',
      null,
    );

  return steps.map((step, index) => ({
    id: `${index + 1}-${step.action}${step.connectionId ? `-${step.connectionId}` : ''}`,
    ...step,
  }));
}

/**
 * Plans the proposed change, or every change the comparison detected, for one order. Throws
 * `OrderChangeRequestError` for a line that is not on the order or an invalid quantity.
 */
export function planOrderChanges(input: OrderChangePlanInput) {
  const shared = sharedComparisonLines(input.sources);
  const items: Evaluated[] = input.sources.map((source) => ({
    source,
    // Payment is not part of any change rule.
    facts: comparisonFacts({ ...source, paymentStatus: 'unknown' }, shared),
    fresh: isFresh(source, input.asOf),
    reportsFulfilment:
      input.fulfillmentsVisible &&
      source.connection.capabilities.includes('fulfillment.read'),
  }));
  const request = input.request;
  if (request) {
    if (
      'lineKey' in request &&
      request.lineKey &&
      !items.some(
        (item) =>
          !item.source.deleted &&
          item.facts.lines.some((line) => line.key === request.lineKey),
      )
    )
      throw new OrderChangeRequestError('unknown_line');
    if (
      request.kind === 'quantity' &&
      !/^\d{1,14}(\.\d{1,6})?$/.test(request.quantity)
    )
      throw new OrderChangeRequestError('invalid_quantity');

    return [
      planChange(input, items, {
        kind: request.kind,
        lineKey: 'lineKey' in request ? request.lineKey : null,
        target: request.kind === 'quantity' ? request.quantity : null,
        origin: 'proposed',
      }),
    ];
  }

  return detectedChanges(input).map((change) =>
    planChange(input, items, {
      ...change,
      target: null,
      origin: 'detected',
    }),
  );
}
