import type {
  ActivityEvent,
  ActivityPage,
  CaseSummary,
  DecisionItem,
  DecisionList,
  OperationsOverview,
  OrderDetail,
} from '@luma/api-contract';
import { getLocale } from '@luma/i18n/runtime';

/*
 * Hand-made sample data for the marketing screenshots. One fictional workspace, Northstar
 * Commerce, runs a Shopify store and JTL-Wawi, and tells the same story as the website: order
 * 48213 is stuck on a fulfillment hold. Text that comes from data rather than the message
 * catalogs is written in both interface languages. Times are relative to now so the stories stay
 * current; the screenshot script freezes the clock.
 */

export const organizationId = '0f3c9a51-7d2e-4b8a-9c61-2e5d8f4a1b07';
const shop = '1a6e4c2b-93d7-4f15-8a0c-6b2e9d4f7a31';
const erp = '2b7f5d3c-a4e8-4026-9b1d-7c3fae508b42';
const alex = '3c8a6e4d-b5f9-4137-8c2e-8d4abf619c53';
const sam = '4d9b7f5e-c6a0-4248-9d3f-9e5bc072ad64';
const orderId = '5eac8a6f-d7b1-4359-8e4a-af6cd183be75';
const holdIssue = '6fbd9b7a-e8c2-446a-9f5b-b07de294cf86';
const lineShirt = '7ace0c8b-f9d3-457b-8a6c-c18ef3a5d097';
const lineTote = '8bdf1d9c-0ae4-468c-9b7d-d29f04b6e1a8';

export const members = [
  { userId: alex, name: 'Alex Morgan' },
  { userId: sam, name: 'Sam Rivera' },
];

export const self = alex;

export const timeZone = 'Europe/Berlin';

export const storeLabel = 'Northstar Shop';

type Text = { en: string; de: string };

/** Picks the sample text for the current interface language. */
const t = (text: Text) => (getLocale() === 'de' ? text.de : text.en);

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const base = {
  consequences: [],
  change: [],
  impact: { level: 'unknown' as const, text: null },
  urgency: 'normal' as const,
  deadline: null,
  requesterId: null,
  assignment: null,
  record: null,
};

const fresh = (minutes: number) => ({
  observedAt: minutesAgo(minutes),
  validUntil: minutesAgo(minutes - 10),
  state: 'fresh' as const,
});

function holdRelease(): DecisionItem {
  return {
    ...base,
    id: 'shopify:fulfillment_recovery:48213',
    kind: 'fulfillment_recovery',
    reason: 'approval',
    domain: 'fulfillment',
    title: t({
      en: 'Release fulfillment hold on order #48213',
      de: 'Fulfillment-Sperre für Bestellung #48213 aufheben',
    }),
    why: t({
      en: 'The order has been on a fraud-review hold in Shopify for 26 hours. Payment is complete and JTL-Wawi has the stock. Releasing the hold needs approval from someone other than the requester.',
      de: 'Die Bestellung steht seit 26 Stunden in der Betrugsprüfung von Shopify. Die Zahlung ist abgeschlossen und JTL-Wawi hat den Bestand. Das Aufheben der Sperre braucht die Genehmigung einer anderen Person als des Antragstellers.',
    }),
    consequences: [
      {
        response: t({ en: 'Approve', de: 'Genehmigen' }),
        text: t({
          en: 'Luma checks the order again, releases the hold in Shopify and confirms with a fresh read that fulfillment can start.',
          de: 'Luma prüft die Bestellung erneut, hebt die Sperre in Shopify auf und bestätigt mit einem erneuten Auslesen, dass das Fulfillment starten kann.',
        }),
      },
      {
        response: t({ en: 'Reject', de: 'Ablehnen' }),
        text: t({
          en: 'The hold stays in place and the issue stays open.',
          de: 'Die Sperre bleibt bestehen und das Problem bleibt offen.',
        }),
      },
    ],
    change: [
      {
        label: t({ en: 'Action', de: 'Aktion' }),
        value: t({ en: 'Release hold', de: 'Sperre aufheben' }),
      },
      {
        label: t({ en: 'Shopify order', de: 'Shopify-Bestellung' }),
        value: '#48213',
      },
      {
        label: t({ en: 'Hold reason', de: 'Grund der Sperre' }),
        value: t({ en: 'Fraud review', de: 'Betrugsprüfung' }),
      },
      {
        label: t({ en: 'Payment', de: 'Zahlung' }),
        value: t({ en: 'Paid', de: 'Bezahlt' }),
      },
      {
        label: t({ en: 'Stock in JTL-Wawi', de: 'Bestand in JTL-Wawi' }),
        value: t({
          en: 'Available for both lines',
          de: 'Für beide Positionen verfügbar',
        }),
      },
    ],
    impact: {
      level: 'high',
      text: t({
        en: '3 items can’t ship until the hold is released',
        de: '3 Artikel können erst nach dem Aufheben versendet werden',
      }),
    },
    urgency: 'high',
    requestedAt: minutesAgo(12),
    evidence: fresh(2),
    requesterId: sam,
    response: 'decide',
    subject: {
      label: t({
        en: 'Fulfillment of order #48213',
        de: 'Fulfillment der Bestellung #48213',
      }),
      detail: `${storeLabel} · Shopify`,
    },
    owner: {
      kind: 'app_fulfillment',
      appId: 'shopify',
      connectionId: shop,
      orderId: 'gid://shopify/Order/48213',
      fulfillmentId: 'gid://shopify/FulfillmentOrder/48213',
    },
    group: {
      key: 'shopify:fulfillment_recovery:approval',
      label: t({
        en: 'Fulfillment holds awaiting approval',
        de: 'Fulfillment-Sperren, die auf Genehmigung warten',
      }),
    },
  };
}

function stockCorrection(): DecisionItem {
  return {
    ...base,
    id: 'shopify:inventory_correction:ls-sand-m',
    kind: 'inventory_correction',
    reason: 'approval',
    domain: 'inventory',
    title: t({
      en: 'Correct Shopify stock for Linen shirt / Sand / M',
      de: 'Shopify-Bestand für Leinenhemd / Sand / M korrigieren',
    }),
    why: t({
      en: 'Shopify shows 8 more units than JTL-Wawi, which holds the stock of record. Changing Shopify needs another person’s approval.',
      de: 'Shopify zeigt 8 Stück mehr als JTL-Wawi, das den führenden Bestand hält. Eine Änderung in Shopify braucht die Genehmigung einer anderen Person.',
    }),
    change: [
      {
        label: t({ en: 'Location', de: 'Lagerort' }),
        value: t({ en: 'Main warehouse', de: 'Hauptlager' }),
      },
      {
        label: t({ en: 'Shopify now', de: 'Shopify aktuell' }),
        value: t({ en: '12 units', de: '12 Stück' }),
      },
      { label: 'JTL-Wawi', value: t({ en: '4 units', de: '4 Stück' }) },
      {
        label: t({ en: 'Change', de: 'Änderung' }),
        value: t({ en: 'Set to 4 (−8)', de: 'Auf 4 setzen (−8)' }),
      },
    ],
    impact: {
      level: 'medium',
      text: t({
        en: 'Could oversell 8 units',
        de: 'Bis zu 8 Stück könnten überverkauft werden',
      }),
    },
    urgency: 'expiring',
    requestedAt: minutesAgo(6),
    deadline: new Date(Date.now() + 4 * 60_000).toISOString(),
    evidence: fresh(1),
    requesterId: alex,
    response: 'awaiting_other',
    assignment: {
      assigneeId: alex,
      assignedBy: alex,
      assignedAt: minutesAgo(5),
      revision: 1,
    },
    subject: {
      label: t({
        en: 'Shopify stock for LS-SAND-M',
        de: 'Shopify-Bestand für LS-SAND-M',
      }),
      detail: t({
        en: 'Stock of record: JTL-Wawi',
        de: 'Führendes System: JTL-Wawi',
      }),
    },
    owner: {
      kind: 'app_inventory',
      appId: 'shopify',
      positionId: '9ce02eab-1bf5-479d-8c8e-e3a015c7f2b9',
    },
    group: {
      key: 'shopify:inventory_correction:approval',
      label: t({
        en: 'Stock corrections awaiting approval',
        de: 'Bestandskorrekturen, die auf Genehmigung warten',
      }),
    },
  };
}

function replenishment(): DecisionItem {
  return {
    ...base,
    id: 'replenishment:ad13fbbc-2c06-48ae-9d9f-f4b126d803ca',
    kind: 'replenishment',
    reason: 'approval',
    domain: 'procurement',
    title: t({
      en: 'Approve purchase-order draft for 40 × Canvas tote',
      de: 'Bestellentwurf über 40 × Canvas-Tasche genehmigen',
    }),
    why: t({
      en: 'Canvas tote / Natural is below its minimum of 20 units. The draft goes to JTL-Wawi only after someone approves it.',
      de: 'Canvas-Tasche / Natur liegt unter dem Mindestbestand von 20 Stück. Der Entwurf geht erst nach einer Genehmigung an JTL-Wawi.',
    }),
    change: [
      { label: 'SKU', value: 'CT-NAT' },
      {
        label: t({ en: 'Supplier', de: 'Lieferant' }),
        value: 'Hanse Textil GmbH',
      },
      {
        label: t({ en: 'Quantity', de: 'Menge' }),
        value: t({ en: '40 units', de: '40 Stück' }),
      },
      {
        label: t({ en: 'Available', de: 'Verfügbar' }),
        value: t({ en: '6 units', de: '6 Stück' }),
      },
    ],
    impact: {
      level: 'medium',
      text: t({
        en: '6 units left, minimum is 20',
        de: 'Noch 6 Stück, Minimum ist 20',
      }),
    },
    requestedAt: minutesAgo(48),
    evidence: fresh(4),
    requesterId: null,
    response: 'decide',
    subject: {
      label: t({ en: 'Stock of CT-NAT', de: 'Bestand von CT-NAT' }),
      detail: 'Hanse Textil GmbH',
    },
    record: { kind: 'position', id: 'be24accd-3d17-49bf-8e0a-05c237e914db' },
    owner: {
      kind: 'workflow_run',
      definitionId: 'inventory-replenishment',
      runId: 'ad13fbbc-2c06-48ae-9d9f-f4b126d803ca',
    },
    group: {
      key: 'replenishment:approval',
      label: t({
        en: 'Purchase-order drafts awaiting approval',
        de: 'Bestellentwürfe, die auf Genehmigung warten',
      }),
    },
  };
}

function outcomeCheck(): DecisionItem {
  return {
    ...base,
    id: 'shopify:fulfillment_recovery:48190',
    kind: 'fulfillment_recovery',
    reason: 'recovery',
    domain: 'fulfillment',
    title: t({
      en: 'Release fulfillment hold on order #48190',
      de: 'Fulfillment-Sperre für Bestellung #48190 aufheben',
    }),
    why: t({
      en: 'Shopify accepted the change, but no fresh read has confirmed the result yet. An accepted change isn’t a confirmed one.',
      de: 'Shopify hat die Änderung angenommen, aber noch kein erneutes Auslesen hat das Ergebnis bestätigt. Eine angenommene Änderung ist keine bestätigte.',
    }),
    consequences: [
      {
        response: t({ en: 'Check', de: 'Prüfen' }),
        text: t({
          en: 'Luma reads Shopify again. Only fewer unfulfilled items on the same lines count as progress.',
          de: 'Luma liest Shopify erneut aus. Nur weniger offene Artikel auf denselben Positionen zählen als Fortschritt.',
        }),
      },
    ],
    impact: {
      level: 'unknown',
      text: t({
        en: '1 item not yet fulfilled',
        de: '1 Artikel noch nicht erfüllt',
      }),
    },
    requestedAt: minutesAgo(95),
    evidence: {
      observedAt: minutesAgo(95),
      validUntil: minutesAgo(85),
      state: 'stale',
    },
    response: 'check',
    subject: {
      label: t({
        en: 'Fulfillment of order #48190',
        de: 'Fulfillment der Bestellung #48190',
      }),
      detail: `${storeLabel} · Shopify`,
    },
    owner: {
      kind: 'app_fulfillment',
      appId: 'shopify',
      connectionId: shop,
      orderId: 'gid://shopify/Order/48190',
      fulfillmentId: 'gid://shopify/FulfillmentOrder/48190',
    },
    group: {
      key: 'shopify:fulfillment_recovery:recovery',
      label: t({
        en: 'Fulfillment recoveries to check',
        de: 'Zu prüfende Fulfillment-Wiederherstellungen',
      }),
    },
  };
}

function manualStep(): DecisionItem {
  return {
    ...base,
    id: 'case:c035bdde-4e28-4ac0-9f1b-16d348fa25ec',
    kind: 'case',
    reason: 'manual_intervention',
    domain: 'inventory',
    title: t({
      en: 'Stock mismatch needs a manual step',
      de: 'Bestandsabweichung braucht einen manuellen Schritt',
    }),
    why: t({
      en: 'Correct the available quantity for MUG-STONE in JTL-Wawi; Shopify follows the ERP.',
      de: 'Korrigiere den verfügbaren Bestand für MUG-STONE in JTL-Wawi; Shopify folgt der Warenwirtschaft.',
    }),
    impact: {
      level: 'low',
      text: t({ en: '2 units differ', de: '2 Stück Abweichung' }),
    },
    requestedAt: minutesAgo(170),
    evidence: fresh(6),
    response: 'investigate',
    subject: {
      label: 'SKU MUG-STONE',
      detail: t({
        en: 'Shopify shows 2 more units than JTL-Wawi.',
        de: 'Shopify zeigt 2 Stück mehr als JTL-Wawi.',
      }),
    },
    owner: {
      kind: 'case',
      exceptionId: 'c035bdde-4e28-4ac0-9f1b-16d348fa25ec',
    },
    group: {
      key: 'case:inventory_mismatch:manual_intervention',
      label: t({
        en: 'Stock mismatch: manual steps',
        de: 'Bestandsabweichung: manuelle Schritte',
      }),
    },
  };
}

/** The Needs you queue: approvals, an outcome check and a manual step. */
export function decisionList(): DecisionList {
  const items = [
    holdRelease(),
    stockCorrection(),
    replenishment(),
    outcomeCheck(),
    manualStep(),
  ];

  return {
    schemaVersion: 1,
    asOf: minutesAgo(0),
    items,
    nextCursor: null,
    totalCount: items.length,
    offset: 0,
    counts: {
      views: { all: items.length, mine: 1, unassigned: 4 },
      domains: {
        orders: 0,
        fulfillment: 2,
        inventory: 2,
        procurement: 1,
        operations: 0,
      },
      reasons: {
        approval: 3,
        run: 0,
        recovery: 1,
        manual_intervention: 1,
        uncertainty: 0,
      },
    },
    sources: [
      {
        id: 'cases',
        label: t({ en: 'Issues', de: 'Probleme' }),
        state: 'available',
      },
      {
        id: 'replenishment',
        label: t({ en: 'Replenishment', de: 'Nachbestellung' }),
        state: 'available',
      },
      { id: 'app:shopify', label: 'Shopify', state: 'available' },
    ],
  };
}

/** The decision shown open in the Needs you screenshot. */
export const openDecisionId = 'shopify:fulfillment_recovery:48213';

function activeCase(
  id: string,
  issueClass: string,
  state: CaseSummary['state'],
  summary: Text,
  minutes: number,
): CaseSummary {
  return {
    schemaVersion: 1,
    id,
    revision: 3,
    class: issueClass,
    state,
    severity: 'medium',
    summary: t(summary),
    subject: { kind: 'order', id, scope: [] },
    sources: ['Shopify', 'JTL'],
    detectedAt: minutesAgo(minutes),
    lastActivityAt: minutesAgo(Math.max(1, minutes - 20)),
    attention: {
      required: false,
      reason: null,
      explanation: '',
      requestedAt: null,
    },
    freshness: 'fresh',
    diagnosisStatus: 'ready',
    resolution: null,
  };
}

/** Issues Luma is working on without a person's decision. */
export function activeCases() {
  const items = [
    activeCase(
      'd146cfef-5f39-4bd1-8a2c-27e459ab36fd',
      'stuck_fulfillment',
      'verifying',
      {
        en: 'Fulfillment for order #48190 restarted in Shopify',
        de: 'Fulfillment für Bestellung #48190 in Shopify neu gestartet',
      },
      120,
    ),
    activeCase(
      'e257d0f0-604a-4ce2-9b3d-38f56abc470e',
      'inventory_mismatch',
      'diagnosed',
      {
        en: 'JTL-Wawi shows 3 more Canvas totes than Shopify',
        de: 'JTL-Wawi zeigt 3 Canvas-Taschen mehr als Shopify',
      },
      64,
    ),
    activeCase(
      'f368e101-7152-4df3-8c4e-49067bcd581f',
      'sync_failure',
      'detected',
      {
        en: 'JTL-Wawi order read is being retried',
        de: 'Das Auslesen der Bestellungen aus JTL-Wawi wird wiederholt',
      },
      18,
    ),
    activeCase(
      '0479f212-8263-4e04-9d5f-5a178cde6920',
      'workflow_failure',
      'detected',
      {
        en: 'Supplier hasn’t confirmed purchase order PO-1182',
        de: 'Der Lieferant hat die Lieferantenbestellung PO-1182 nicht bestätigt',
      },
      35,
    ),
  ];

  return {
    totalCount: items.length,
    offset: 0,
    items,
    nextCursor: null,
    coverage: 'observed' as const,
  };
}

/** Home's summary: counts for the last 24 hours and both connections reporting. */
export function overview(): OperationsOverview {
  return {
    generatedAt: minutesAgo(0),
    window: { start: minutesAgo(24 * 60), end: minutesAgo(0) },
    freshnessThresholdHours: 24,
    connections: [
      {
        id: shop,
        label: `${storeLabel} · Shopify`,
        status: 'active',
        lastObservedAt: minutesAgo(1),
        freshness: 'fresh',
      },
      {
        id: erp,
        label: 'JTL-Wawi',
        status: 'active',
        lastObservedAt: minutesAgo(3),
        freshness: 'fresh',
      },
    ],
    attentionCount: 5,
    activeCount: 9,
    verifiedResolutions: 14,
    automaticallyResolved: 3,
    automation: { numerator: 3, denominator: 14 },
    prioritizedDecisions: [],
  };
}

function event(
  id: string,
  minutes: number,
  type: ActivityEvent['type'],
  outcome: ActivityEvent['outcome'],
  summary: Text,
  system: string | null,
  actor: ActivityEvent['actor']['kind'] = 'luma',
): ActivityEvent {
  return {
    id,
    recordedAt: minutesAgo(minutes),
    occurredAt: minutesAgo(minutes),
    actor: {
      kind: actor,
      id: actor === 'member' ? sam : null,
      name: actor === 'member' ? 'Sam Rivera' : null,
      email: null,
      workflow: null,
    },
    action: `${type}.${outcome}`,
    type,
    outcome,
    exceptionId: null,
    proposalId: null,
    attemptId: null,
    connectionId: null,
    system,
    resource: null,
    playbookId: null,
    mode: 'pilot',
    summary: t(summary),
    executionState: null,
    verificationPhase: null,
    failureCode: null,
    connections: [],
    dispatch: null,
    verification: null,
    evidenceRefs: [],
  };
}

/** The latest recorded decisions, changes and checks. */
export function activity(): ActivityPage {
  return {
    visibility: 'member',
    nextCursor: null,
    coverage: 'complete',
    items: [
      event(
        'evt-6',
        4,
        'verification',
        'verified',
        {
          en: 'Stock for LS-SAND-M matches JTL-Wawi again',
          de: 'Bestand für LS-SAND-M stimmt wieder mit JTL-Wawi überein',
        },
        'Shopify',
      ),
      event(
        'evt-5',
        12,
        'issue',
        'recorded',
        {
          en: 'Order #48213 has been on hold for longer than your limit',
          de: 'Bestellung #48213 ist länger als erlaubt gesperrt',
        },
        'Shopify',
      ),
      event(
        'evt-4',
        31,
        'decision',
        'approved',
        {
          en: 'Sam Rivera approved releasing the hold on order #48190',
          de: 'Sam Rivera hat das Aufheben der Sperre für Bestellung #48190 genehmigt',
        },
        null,
        'member',
      ),
      event(
        'evt-3',
        33,
        'execution',
        'provider_accepted',
        {
          en: 'Shopify accepted the hold release for order #48190',
          de: 'Shopify hat das Aufheben der Sperre für Bestellung #48190 angenommen',
        },
        'Shopify',
      ),
      event(
        'evt-2',
        58,
        'verification',
        'verified',
        {
          en: 'Purchase order PO-1179 arrived in JTL-Wawi',
          de: 'Lieferantenbestellung PO-1179 ist in JTL-Wawi angekommen',
        },
        'JTL-Wawi',
      ),
      event(
        'evt-1',
        76,
        'issue',
        'recorded',
        {
          en: 'JTL-Wawi shows 3 more Canvas totes than Shopify',
          de: 'JTL-Wawi zeigt 3 Canvas-Taschen mehr als Shopify',
        },
        'JTL-Wawi',
      ),
    ],
  };
}

const line = (
  id: string,
  sku: string,
  title: Text,
  quantity: string,
  fulfilled: string,
): OrderDetail['sources'][number]['lines'][number] => ({
  id,
  skuId: id,
  skuCode: sku,
  title: t(title),
  quantity,
  currentQuantity: quantity,
  cancelledQuantity: '0',
  unit: 'each',
  fulfilledQuantity: fulfilled,
  remainingQuantity: String(Number(quantity) - Number(fulfilled)),
});

/** Order 48213 as Luma sees it in Shopify and JTL-Wawi, with its issue and Workflow run. */
export function orderDetail(): OrderDetail {
  const placedAt = minutesAgo(27 * 60);
  const lines = [
    line(
      lineShirt,
      'LS-SAND-M',
      { en: 'Linen shirt / Sand / M', de: 'Leinenhemd / Sand / M' },
      '2',
      '0',
    ),
    line(
      lineTote,
      'CT-NAT',
      { en: 'Canvas tote / Natural', de: 'Canvas-Tasche / Natur' },
      '1',
      '0',
    ),
  ];
  const shopSource = {
    connectionId: shop,
    label: storeLabel,
    system: 'shopify',
    connectionStatus: 'active' as const,
    externalId: 'gid://shopify/Order/5820148213',
    selected: true,
    deleted: false,
    observedAt: minutesAgo(1),
    sourceUpdatedAt: minutesAgo(26 * 60),
  };
  const erpSource = {
    connectionId: erp,
    label: 'JTL-Wawi',
    system: 'jtl',
    connectionStatus: 'active' as const,
    externalId: 'AU-2026-48213',
    selected: false,
    deleted: false,
    observedAt: minutesAgo(3),
    sourceUpdatedAt: minutesAgo(26 * 60 + 40),
  };

  return {
    order: {
      id: orderId,
      displayNumber: '#48213',
      placedAt,
      total: { amount: '184.00', currency: 'EUR' },
      status: 'open',
      paymentStatus: 'paid',
      fulfillment: 'unfulfilled',
      lineCount: 2,
      open: true,
      overdue: true,
      dueAt: minutesAgo(3 * 60),
      issueIds: [holdIssue],
      differs: false,
      sources: [shopSource, erpSource],
      observedAt: minutesAgo(1),
      sourceUpdatedAt: minutesAgo(26 * 60),
    },
    sources: [
      {
        ...shopSource,
        appId: 'shopify',
        mappingMethod:
          'Linked by a person as the same record in another source',
        displayNumber: '#48213',
        status: 'open',
        paymentStatus: 'paid',
        placedAt,
        total: { amount: '184.00', currency: 'EUR' },
        dueAt: minutesAgo(3 * 60),
        fulfillment: 'unfulfilled',
        open: true,
        lines,
      },
      {
        ...erpSource,
        appId: 'jtl',
        mappingMethod:
          'Linked by a person as the same record in another source',
        displayNumber: 'AU-2026-48213',
        status: 'open',
        paymentStatus: 'paid',
        placedAt: minutesAgo(27 * 60 - 4),
        total: { amount: '184.00', currency: 'EUR' },
        dueAt: minutesAgo(3 * 60),
        fulfillment: 'unfulfilled',
        open: true,
        lines,
      },
    ],
    differences: [],
    fulfillments: [],
    returns: [],
    issues: [
      {
        id: holdIssue,
        class: 'stuck_fulfillment',
        state: 'awaiting_approval',
        severity: 'high',
        relationship: 'order',
        needsYou: true,
        lastDetectedAt: minutesAgo(12),
      },
    ],
    workflows: [
      {
        id: 'a58af323-9374-4f06-8e60-6b289def7a30',
        definitionId: 'fulfillment-hold-release',
        name: t({
          en: 'Release overdue fulfillment holds',
          de: 'Überfällige Fulfillment-Sperren aufheben',
        }),
        version: '3',
        createdAt: minutesAgo(12),
        state: 'awaiting_approval',
        relationship: 'issue',
      },
    ],
    history: {
      entries: [
        {
          snapshotId: 'b69b0434-a485-4017-9f71-7c39a0ef8b41',
          entityKind: 'order',
          entityId: orderId,
          connectionId: shop,
          status: 'open',
          paymentStatus: 'paid',
          deleted: false,
          current: true,
          observedAt: minutesAgo(1),
          sourceUpdatedAt: minutesAgo(26 * 60),
        },
        {
          snapshotId: 'c7ac1545-b596-4128-8a82-8d4ab1f09c52',
          entityKind: 'order',
          entityId: orderId,
          connectionId: erp,
          status: 'open',
          paymentStatus: 'paid',
          deleted: false,
          current: true,
          observedAt: minutesAgo(3),
          sourceUpdatedAt: minutesAgo(26 * 60 + 40),
        },
      ],
      truncated: false,
    },
    activity: {
      entries: [
        {
          id: 'order-evt-2',
          recordedAt: minutesAgo(12),
          action: 'exception.detected',
          type: 'issue',
          outcome: 'recorded',
          actor: {
            kind: 'luma',
            id: null,
            name: null,
            email: null,
            workflow: null,
          },
          exceptionId: holdIssue,
          summary: null,
        },
      ],
      truncated: false,
    },
    asOf: minutesAgo(0),
  };
}
