type Value = string | number | boolean | null;

/** A review of immutable intent. Unknown baselines and newly created provider IDs stay explicit. */
export interface ActionDiff {
  schemaVersion: 1;
  /** Persisted policy result; absence never means approval is unnecessary. */
  policy?: {
    outcome: 'allowed' | 'denied' | 'approval_required';
    reason: string;
    evaluatedAt: string;
    validUntil: string;
    current: boolean;
  } | null;
  capability: string;
  records: {
    system: 'luma' | 'provider';
    connectionId: string | null;
    kind: string;
    id: string | null;
    /** Authorized application record link, when the owner supplied one. */
    link?: string;
    changes: {
      field: string;
      before: Value;
      beforeKnown: boolean;
      after: Value;
      afterKnown: boolean;
      expected: Value;
      expectedKnown: boolean;
    }[];
  }[];
  scope: { kind: string; count: number | null; ids: string[] }[];
  reversibility: 'reversible' | 'compensatable' | 'irreversible' | 'unknown';
  evidence: {
    link?: string;
    refs: string[];
    observedAt: string | null;
    ageSeconds?: number | null;
    validUntil: string;
  };
  retryProtection: 'immutable_intent_reconcile_before_retry';
  canonicalOutcome: 'requires_fresh_verification' | 'internal_record';
}

interface Intent {
  tenantId: string;
  connectionId: string;
  capability: string;
  target: { kind: string; id: string };
  parameters: Record<string, Value>;
  expectedPostcondition: Record<string, Value>;
  preconditions: { evidenceRefs: string[]; validUntil: string };
}

// Each key corresponds to an installed effect. Reversibility describes the business effect,
// not an automatic undo endpoint; compensation always needs a separately reviewed action.
const semantics: Record<string, ActionDiff['reversibility']> = {
  'inventory.available.reconcile': 'compensatable',
  'inventory.write': 'compensatable',
  'orders.shipping-method.write': 'compensatable',
  'orders.quantity.edit': 'compensatable',
  'orders.quantity.update': 'compensatable',
  'orders.write': 'irreversible',
  'fulfillment.retry': 'unknown',
  'fulfillment.hold.release': 'compensatable',
  'fulfillment.open': 'compensatable',
  'fulfillment.move': 'compensatable',
  'fulfillment.shipment.create': 'irreversible',
  'fulfillment.tracking.update': 'compensatable',
  'purchase-orders.submit': 'irreversible',
  'purchase-orders.revise': 'compensatable',
  'returns.create': 'compensatable',
  'returns.refund': 'irreversible',
  'returns.restock': 'compensatable',
  'returns.exchange.request': 'compensatable',
  'returns.exchange.process': 'irreversible',
  'returns.exchange.cancel': 'irreversible',
  'returns.exchange.release': 'compensatable',
  'messages.send': 'irreversible',
  'procurement.purchase-order.create': 'compensatable',
  'procurement.purchase-order.transition': 'unknown',
  'procurement.follow-up.record': 'compensatable',
};

const expectedFields: Record<string, string> = {
  available: 'expectedAvailable',
  quantity: 'expectedQuantity',
  shippingMethodId: 'expectedShippingMethodId',
  valueJson: 'beforeValueJson',
  revision: 'expectedRevision',
};
const scalar = (value: unknown): value is Value =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function json(value: Value | undefined): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Builds the shared review from validated, persisted action facts. It understands the installed
 * adapters' parameter encodings, including exact line baselines. It never reads providers or
 * treats operation IDs as provider record IDs. Unregistered capabilities return null, so release
 * gated admission can reject them. Observation time must come from retained owner evidence.
 */
export function describeActionDiff(
  intent: Intent,
  observedAt: string | null = null,
  baseline?: Record<string, unknown>,
): ActionDiff | null {
  const reversibility =
    semantics[intent.capability] ??
    (['order', 'product', 'supplier', 'purchase_order'].some(
      (kind) => intent.capability === `adaptive.${kind}.field.write`,
    )
      ? 'compensatable'
      : undefined);
  if (!reversibility) return null;
  const internal = intent.connectionId === intent.tenantId;
  const changes: ActionDiff['records'][number]['changes'] = [];
  const add = (
    field: string,
    after: Value,
    before?: Value,
    afterKnown = true,
  ) => {
    changes.push({
      field,
      before: before ?? null,
      beforeKnown: before !== undefined,
      after,
      afterKnown,
      expected: before ?? null,
      expectedKnown: before !== undefined,
    });
  };
  for (const [field, after] of Object.entries(intent.expectedPostcondition)) {
    const key = expectedFields[field];
    const before =
      key && Object.hasOwn(intent.parameters, key)
        ? intent.parameters[key]
        : field === 'valueJson' &&
            Object.hasOwn(intent.parameters, 'expectedValueJson')
          ? intent.parameters.expectedValueJson
          : undefined;
    add(
      field,
      after,
      before === undefined && baseline && scalar(baseline[field])
        ? baseline[field]
        : before,
    );
  }
  let kind = intent.target.kind;
  let id: string | null = intent.target.id;
  // The immutable intent binds operation identities separately from the records the adapter touches.
  if (!internal && intent.target.kind.startsWith('shopify_')) {
    if (intent.capability === 'inventory.available.reconcile') {
      kind = 'inventory_item';
      id =
        typeof intent.parameters.inventoryItemId === 'string'
          ? intent.parameters.inventoryItemId
          : null;
    } else if (intent.capability === 'fulfillment.shipment.create') {
      kind = 'fulfillment';
      id = null;
    } else if (
      intent.capability.startsWith('fulfillment.') &&
      intent.capability !== 'fulfillment.shipment.create'
    ) {
      kind = 'fulfillment_order';
      id =
        typeof intent.parameters.fulfillmentOrderId === 'string'
          ? intent.parameters.fulfillmentOrderId
          : null;
    } else {
      kind = 'order';
      id =
        typeof intent.parameters.orderId === 'string'
          ? intent.parameters.orderId
          : null;
    }
  } else if (intent.target.kind === 'starshipit_order_update') {
    kind = 'order';
    id =
      typeof intent.parameters.orderId === 'string'
        ? intent.parameters.orderId
        : null;
  } else if (
    [
      'purchase_order_submission',
      'return_case_creation',
      'return_case_settlement',
      'return_case_exchange',
      'message_outbound',
    ].includes(intent.target.kind)
  ) {
    kind =
      intent.target.kind === 'purchase_order_submission'
        ? 'purchase_order'
        : intent.target.kind === 'message_outbound'
          ? 'message'
          : 'return';
    // A provider assigns the newly created record identity; a Luma request UUID is not that ID.
    id = null;
  }
  if (intent.capability === 'fulfillment.open')
    add(
      'status',
      'OPEN',
      baseline && scalar(baseline.status) ? baseline.status : undefined,
    );
  if (
    intent.capability === 'fulfillment.hold.release' &&
    typeof intent.parameters.holdId === 'string'
  ) {
    const holds = baseline?.holds;
    const known = Array.isArray(holds) && holds.every(object);
    add(
      `holds[${intent.parameters.holdId}].present`,
      false,
      known
        ? holds.some((hold) => hold.id === intent.parameters.holdId)
        : undefined,
    );
  }
  const revisionProvider = json(intent.parameters.provider);
  if (
    intent.capability === 'purchase-orders.revise' &&
    object(revisionProvider)
  ) {
    if (
      object(revisionProvider.order) &&
      typeof revisionProvider.order.externalId === 'string'
    ) {
      kind = 'purchase_order';
      id = revisionProvider.order.externalId;
    }
    const expected = revisionProvider.expected;
    const operation = revisionProvider.operation;
    if (object(expected) && object(operation)) {
      const line = object(operation.line) ? operation.line : null;
      const beforeLine = Array.isArray(expected.lines)
        ? expected.lines.find(
            (value) =>
              object(value) &&
              object(value.id) &&
              line &&
              value.id.externalId === line.externalId &&
              value.id.scopeKey === line.scopeKey,
          )
        : undefined;
      const key =
        line && typeof line.externalId === 'string' ? line.externalId : 'new';
      if (operation.kind === 'remove_line')
        add(
          `lines[${key}].present`,
          false,
          object(beforeLine) ? true : undefined,
        );
      for (const field of ['quantity', 'requestedDeliveryDate'] as const)
        if (scalar(operation[field]))
          add(
            `lines[${key}].${field}`,
            operation[field],
            object(beforeLine) && scalar(beforeLine[field])
              ? beforeLine[field]
              : field === 'quantity' &&
                  object(beforeLine) &&
                  object(beforeLine.quantity) &&
                  typeof beforeLine.quantity.amount === 'string'
                ? beforeLine.quantity.amount
                : undefined,
          );
    }
  }
  const plan = json(intent.parameters.plan) ?? baseline?.plan;
  const scope = new Map<string, { count: number | null; ids: string[] }>();
  const include = (
    scopeKind: string,
    ids: string[],
    count: number | null = new Set(ids).size,
  ) => {
    const previous = scope.get(scopeKind);
    const merged = [...new Set([...(previous?.ids ?? []), ...ids])];
    scope.set(scopeKind, {
      ids: merged.slice(0, 100),
      count:
        count === null || previous?.count === null
          ? null
          : Math.max(count, merged.length),
    });
  };
  include(kind, id === null ? [] : [id], 1);
  for (const [key, scopeKind] of [
    ['orderId', 'order'],
    ['locationId', 'location'],
    ['warehouseId', 'location'],
    ['supplierId', 'supplier'],
    ['customerId', 'customer'],
    ['purchaseOrderId', 'purchase_order'],
    ['returnCaseId', 'return_case'],
  ] as const) {
    const value = intent.parameters[key];
    if (typeof value === 'string') include(scopeKind, [value]);
  }
  if (intent.capability.startsWith('returns.') && object(plan)) {
    for (const key of ['order', 'warehouse', 'item'] as const) {
      const source = plan[key];
      if (object(source) && typeof source.externalId === 'string')
        include(
          key === 'warehouse'
            ? 'location'
            : key === 'item'
              ? 'inventory_item'
              : key,
          [source.externalId],
        );
    }
    for (const field of [
      'amount',
      'currency',
      'quantity',
      'returnId',
      'fulfillmentOrderId',
      'holdId',
    ] as const)
      if (scalar(plan[field])) add(field, plan[field]);
    if (plan.kind === 'restock' && scalar(plan.baselineOnHand))
      add('onHand', null, plan.baselineOnHand, false);
    const lines = Array.isArray(plan.lines) ? plan.lines : plan.returnLines;
    if (Array.isArray(lines))
      for (const [index, line] of lines.entries()) {
        if (!object(line)) continue;
        const source = line.orderLine;
        const lineId =
          object(source) && typeof source.externalId === 'string'
            ? source.externalId
            : typeof line.id === 'string'
              ? line.id
              : String(index);
        include('order_line', [lineId]);
        if (scalar(line.quantity))
          add(`lines[${lineId}].quantity`, line.quantity);
      }
    for (const nested of ['replacement', 'financial'] as const) {
      const value = plan[nested];
      if (!object(value)) continue;
      for (const field of [
        'kind',
        'amount',
        'currency',
        'quantity',
        'skuId',
        'variantId',
      ] as const)
        if (scalar(value[field])) add(`${nested}.${field}`, value[field]);
    }
  }
  if (
    intent.capability === 'orders.quantity.edit' &&
    typeof intent.parameters.lines === 'string'
  ) {
    const parsed = intent.parameters.lines
      .split(',')
      .map((line) => /^(\d+):(\d+)>(\d+)$/.exec(line));
    if (parsed.every((line) => line !== null)) {
      changes.splice(
        0,
        changes.length,
        ...changes.filter((change) => change.field !== 'lineQuantities'),
      );
      for (const line of parsed)
        if (line)
          add(
            `lines[gid://shopify/LineItem/${line[1]}].quantity`,
            Number(line[3]),
            Number(line[2]),
          );
      include(
        'order_line',
        parsed.flatMap((line) =>
          line ? [`gid://shopify/LineItem/${line[1]}`] : [],
        ),
      );
      if (Object.hasOwn(intent.parameters, 'restock'))
        add('restock', intent.parameters.restock!);
    }
  } else {
    const lines = json(intent.parameters.lines);
    if (Array.isArray(lines) && lines.every(object)) {
      if (intent.capability === 'orders.quantity.update')
        changes.splice(
          0,
          changes.length,
          ...changes.filter((change) => change.field !== 'lineQuantities'),
        );
      for (const [index, line] of lines.entries()) {
        const lineId = [
          line.lineItemId,
          line.orderLineId,
          line.lineId,
          line.id,
          line.skuId,
          line.sku,
        ].find((value) => typeof value === 'string');
        if (typeof lineId === 'string')
          include(
            (typeof line.skuId === 'string' && lineId === line.skuId) ||
              (typeof line.sku === 'string' && lineId === line.sku)
              ? 'sku'
              : 'order_line',
            [lineId],
          );
        for (const [field, after] of Object.entries(line)) {
          if (
            !scalar(after) ||
            [
              'currentQuantity',
              'lineItemId',
              'orderLineId',
              'lineId',
              'id',
            ].includes(field)
          )
            continue;
          const before =
            field === 'quantity' && scalar(line.currentQuantity)
              ? line.currentQuantity
              : undefined;
          add(`lines[${lineId ?? index}].${field}`, after, before);
        }
      }
    }
  }
  for (const field of [
    'locationId',
    'holdId',
    'requestedDeliveryDate',
    'reference',
    'recipients',
    'contentDigest',
    'fieldId',
    'nextCheckAt',
    'key',
  ] as const) {
    if (
      Object.hasOwn(intent.parameters, field) &&
      !changes.some((change) => change.field === field)
    )
      add(
        field,
        intent.parameters[field]!,
        baseline && scalar(baseline[field]) ? baseline[field] : undefined,
      );
  }
  if (intent.capability.startsWith('inventory.')) {
    if (!scope.has('location')) include('location', [], null);
    include('listing', [], null);
  }
  if (kind === 'order' || intent.parameters.orderId || scope.has('order')) {
    if (!scope.has('customer')) include('customer', [], null);
    if (intent.parameters.restock === true && !scope.has('location'))
      include('location', [], null);
  }
  // Revision checks are explicit guards; they never imply a known business baseline.
  const revision =
    intent.parameters.expectedRevision ?? intent.parameters.revision;
  if (
    revision !== undefined &&
    !changes.some((change) => change.field === 'revision')
  )
    add('revision', null, revision, false);

  return {
    schemaVersion: 1,
    capability: intent.capability,
    records: [
      {
        system: internal ? 'luma' : 'provider',
        connectionId: internal ? null : intent.connectionId,
        kind,
        id,
        changes,
      },
    ],
    scope: [...scope].map(([scopeKind, value]) => ({
      kind: scopeKind,
      ...value,
    })),
    reversibility,
    evidence: {
      refs: [...intent.preconditions.evidenceRefs],
      observedAt,
      validUntil: intent.preconditions.validUntil,
    },
    retryProtection: 'immutable_intent_reconcile_before_retry',
    canonicalOutcome: internal
      ? 'internal_record'
      : 'requires_fresh_verification',
  };
}
