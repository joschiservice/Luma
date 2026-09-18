import type { CaseDetail, Diagnosis } from '@luma/api-contract';

const observedAt = '2026-09-18T08:00:00.000Z';
const refs = ['shopify-stock', 'jtl-stock', 'sku-mapping'];
const finding = (code: string, text: string) => ({
  code,
  text,
  evidenceRefs: refs,
});
const diagnosis: Diagnosis = {
  schemaVersion: 1,
  exceptionId: '11111111-1111-4111-8111-111111111111',
  revision: 2,
  status: 'ready',
  reason: 'inventory_difference',
  superseded: false,
  summary: 'Shopify shows 8 more available than JTL.',
  detectorDecision: {
    decision: 'detect',
    severity: 'high',
    reason: 'inventory_difference',
  },
  affected: {
    kind: 'sku',
    id: 'Linen Shirt / Sand / M',
    scope: ['shared-stock-pool'],
  },
  facts: [
    finding(
      'quantities',
      'Shopify available: 12 units. JTL available: 4 units.',
    ),
    finding(
      'mapping',
      'Explicit mappings establish equivalent SKU, units and stock pool. JTL is the configured authority.',
    ),
    finding(
      'freshness',
      'Both observations are complete and pass freshness and skew checks.',
    ),
  ],
  hypotheses: [
    {
      ...finding(
        'delayed_update',
        'A delayed update may explain the difference.',
      ),
      contradictingEvidenceRefs: [],
      uncertainty: 'unsubstantiated',
      missingChecks: ['Inspect sync job evidence before attributing a cause.'],
      origin: 'rule',
    },
  ],
  constraints: ['A stock mismatch alone does not prove a failed sync.'],
  impact: {
    observed: [],
    potential: [
      finding(
        'oversell',
        'Potential oversell exposure on the selling channel.',
      ),
    ],
    exposedQuantity: '8',
    unit: 'units',
    cost: null,
  },
  nextSteps: [
    {
      ...finding(
        'manual_stock',
        'Review authoritative JTL stock and have an authorized operator correct Shopify.',
      ),
      kind: 'manual_intervention',
      preconditions: [
        'Confirm the mapping and authority against fresh observations.',
      ],
      verificationCriteria: [
        'Fresh complete observations from both equivalent pools agree after correction.',
      ],
      capabilityLimitations: [
        'Current adapters have no inventory-write or conditional-revision capability.',
      ],
    },
  ],
  attention: {
    suggested: true,
    reason: 'manual_intervention',
    evidenceRefs: refs,
    dueAt: observedAt,
  },
  provenance: {
    generatedAt: observedAt,
    engineVersion: 'diagnosis-v1',
    ruleVersion: 'taxonomy-v0',
    configVersion: 'stock-authority-v1',
    mappingVersions: ['linen-sand-m-v1'],
    evidence: refs.map((id, i) => ({
      id,
      observedAt,
      sourceUpdatedAt: null,
      adapterVersion: i === 2 ? 'canonical-mapping-v1' : 'fixture-v1',
      schemaVersion: 1,
      source:
        i === 2
          ? null
          : {
              provider: i === 0 ? 'Shopify' : 'JTL',
              resource: 'Inventory',
              externalId: 'LINEN-SAND-M',
              scopeKey: 'shared-stock-pool',
            },
    })),
    validUntil: '2026-09-18T08:05:00.000Z',
    model: { status: 'disabled', model: null, promptVersion: null },
    reread: { status: 'unavailable', retryAfter: null },
  },
};
export const inventoryCase: CaseDetail = {
  schemaVersion: 1,
  id: diagnosis.exceptionId,
  revision: 2,
  class: 'inventory_mismatch',
  state: 'detected',
  severity: 'high',
  summary: diagnosis.summary,
  subject: diagnosis.affected,
  sources: ['Shopify', 'JTL'],
  detectedAt: observedAt,
  lastActivityAt: observedAt,
  attention: {
    required: true,
    reason: 'manual_intervention',
    explanation: 'An authorized operator must review the stock correction.',
    requestedAt: observedAt,
  },
  freshness: 'fresh',
  diagnosisStatus: 'ready',
  resolution: null,
  diagnosis,
};
export function caseFixture(
  variant:
    | 'pending'
    | 'uncertain'
    | 'stale'
    | 'failed'
    | 'resolved'
    | 'sync_failure'
    | 'stuck_fulfillment'
    | 'workflow_failure'
    | 'unknown',
): CaseDetail {
  const item = structuredClone(inventoryCase);
  if (variant === 'pending') {
    item.diagnosis = null;
    item.diagnosisStatus = 'pending';
    item.summary = 'Inventory quantities differ across mapped sources.';
    item.attention = {
      required: false,
      reason: null,
      explanation: 'Investigation is pending.',
      requestedAt: null,
    };
    item.freshness = 'unknown';
  } else if (variant === 'uncertain') {
    item.summary = 'Stock authority needs investigation.';
    item.diagnosisStatus = 'insufficient_evidence';
    item.diagnosis!.status = 'insufficient_evidence';
    item.diagnosis!.summary = item.summary;
    item.diagnosis!.facts = [
      finding(
        'quantities',
        'Shopify reports 12 units and JTL reports 4 units. Authority is not configured.',
      ),
    ];
    item.diagnosis!.impact = {
      observed: [],
      potential: [],
      exposedQuantity: null,
      unit: null,
      cost: null,
    };
    item.diagnosis!.constraints = [
      'Missing authority prevents choosing a correction direction.',
    ];
    item.diagnosis!.hypotheses = [];
    item.diagnosis!.nextSteps = [
      {
        ...finding(
          'authority',
          'Establish mappings, units and stock authority before choosing a correction.',
        ),
        kind: 'read_investigate',
        preconditions: [],
        verificationCriteria: [
          'Configured authority supports a fresh comparison.',
        ],
        capabilityLimitations: [],
      },
    ];
  } else if (variant === 'stale') {
    item.freshness = 'stale';
    item.diagnosis!.superseded = true;
    item.diagnosisStatus = 'insufficient_evidence';
    item.diagnosis!.status = 'insufficient_evidence';
  } else if (variant === 'failed') {
    item.diagnosisStatus = 'failed';
    item.diagnosis!.status = 'failed';
  } else if (variant === 'resolved') {
    item.state = 'resolved';
    item.resolution = 'verified';
    item.diagnosis!.superseded = true;
  } else {
    item.class = variant;
    item.summary =
      variant === 'sync_failure'
        ? 'The connection read failed.'
        : variant === 'stuck_fulfillment'
          ? 'Fulfillment progress needs review.'
          : variant === 'workflow_failure'
            ? 'A workflow did not reach its expected outcome.'
            : 'An operation needs investigation.';
    item.diagnosis = null;
    item.diagnosisStatus = 'pending';
    item.subject = { kind: 'operation', id: 'Operation 1042', scope: [] };
    item.sources = ['JTL'];
  }
  return item;
}
