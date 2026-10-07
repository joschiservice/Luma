import { evaluate } from './evaluate.js';
import type { Configuration, Decision, EvaluationInput } from './facts.js';
import { decimalString, decimalUnits } from './facts.js';

export const diagnosisVersion = 'diagnosis-v1';

export interface Finding {
  code: string;
  text: string;
  evidenceRefs: string[];
}

export interface Hypothesis extends Finding {
  contradictingEvidenceRefs: string[];
  uncertainty: 'unsubstantiated';
  missingChecks: string[];
  origin: 'rule' | 'model';
}

/** Recommendations carry no execution authority. Candidate proposals are owned by policies. */
export interface NextStep extends Finding {
  kind: 'read_investigate' | 'manual_intervention';
  preconditions: string[];
  verificationCriteria: string[];
  capabilityLimitations: string[];
}

export interface Diagnosis {
  schemaVersion: 1;
  exceptionId: string;
  revision: number;
  status: 'pending' | 'ready' | 'insufficient_evidence' | 'failed';
  reason: string;
  superseded: boolean;
  summary: string;
  detectorDecision: Decision;
  affected: { kind: string; id: string; scope: string[] };
  facts: Finding[];
  hypotheses: Hypothesis[];
  constraints: string[];
  impact: {
    observed: Finding[];
    potential: Finding[];
    exposedQuantity: string | null;
    unit: string | null;
    cost: null;
  };
  nextSteps: NextStep[];
  attention: {
    suggested: boolean;
    reason: string;
    evidenceRefs: string[];
    dueAt: string | null;
  };
  provenance: {
    generatedAt: string;
    engineVersion: string;
    ruleVersion: string;
    configVersion: string;
    mappingVersions: string[];
    evidence: {
      id: string;
      observedAt: string;
      sourceUpdatedAt: string | null;
      adapterVersion: string;
      schemaVersion: number;
      source: {
        provider: string;
        resource: string;
        externalId: string;
        scopeKey: string;
      } | null;
    }[];
    validUntil: string | null;
    model: {
      status: 'disabled' | 'used' | 'unavailable' | 'rejected';
      model: string | null;
      promptVersion: string | null;
    };
    reread: {
      status:
        | 'not_requested'
        | 'unavailable'
        | 'completed'
        | 'rate_limited'
        | 'failed';
      retryAfter: string | null;
    };
  };
}

export interface DiagnosisInput {
  exceptionId: string;
  revision: number;
  firstDetectedAt: string;
  reviewRequired: boolean;
  subject: Diagnosis['affected'];
  input: EvaluationInput;
  configuration: Configuration;
  evidence: {
    key: string;
    tenantId: string;
    connectionId: string | null;
    observedAt: string;
    sourceUpdatedAt: string | null;
    adapterVersion: string;
    schemaVersion: 1;
    source: Diagnosis['provenance']['evidence'][number]['source'];
    facts: Record<string, unknown>;
  }[];
}

/**
 * Builds an evidence-backed diagnosis at the supplied timestamp without performing provider
 * reads or authorizing actions.
 */
export function diagnose(snapshot: DiagnosisInput, now: string): Diagnosis {
  const { input, configuration, evidence } = snapshot;
  const refs = [...input.facts.evidenceRefs].sort();
  if (
    input.facts.tenantId !== input.facts.evidenceTenantId ||
    evidence.some((e) => e.tenantId !== input.facts.tenantId) ||
    new Set(refs).size !== refs.length ||
    evidence.length !== refs.length ||
    new Set(evidence.map((e) => e.key)).size !== refs.length ||
    evidence.some((e) => !refs.includes(e.key))
  )
    throw new Error('Diagnosis evidence scope mismatch');
  const decision = evaluate(input, now, configuration.thresholds);
  const finding = (code: string, text: string): Finding => ({
    code,
    text,
    evidenceRefs: refs,
  });
  const result: Diagnosis = {
    schemaVersion: 1,
    exceptionId: snapshot.exceptionId,
    revision: snapshot.revision,
    status: decision.decision === 'defer' ? 'insufficient_evidence' : 'ready',
    reason: decision.reason,
    superseded: false,
    summary: 'Review the evidence before taking action.',
    detectorDecision: decision,
    affected: snapshot.subject,
    facts: [],
    hypotheses: [],
    constraints: [],
    impact: {
      observed: [],
      potential: [],
      exposedQuantity: null,
      unit: null,
      cost: null,
    },
    nextSteps: [],
    attention: {
      suggested: false,
      reason: 'within_review_window',
      evidenceRefs: refs,
      dueAt: null,
    },
    provenance: {
      generatedAt: now,
      engineVersion: diagnosisVersion,
      ruleVersion: configuration.ruleVersion,
      configVersion: configuration.version,
      mappingVersions: [
        ...new Set(
          evidence
            .filter((e) => e.adapterVersion === 'canonical-mapping-v1')
            .map((e) => e.facts.version)
            .filter((v): v is string => typeof v === 'string'),
        ),
      ].sort(),
      evidence: evidence
        .slice()
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((e) => ({
          id: e.key,
          observedAt: e.observedAt,
          sourceUpdatedAt: e.sourceUpdatedAt,
          adapterVersion: e.adapterVersion,
          schemaVersion: e.schemaVersion,
          source: e.source,
        })),
      validUntil:
        input.exceptionClass === 'inventory_mismatch'
          ? new Date(
              Math.min(
                Date.parse(input.facts.leftObservedAt),
                Date.parse(input.facts.rightObservedAt),
              ) +
                configuration.thresholds.freshnessSeconds * 1000,
            ).toISOString()
          : input.exceptionClass === 'stuck_fulfillment'
            ? new Date(
                Date.parse(input.facts.observedAt) +
                  configuration.thresholds.freshnessSeconds * 1000,
              ).toISOString()
            : null,
      model: { status: 'disabled', model: null, promptVersion: null },
      reread: { status: 'not_requested', retryAfter: null },
    },
  };
  const step = (
    kind: NextStep['kind'],
    code: string,
    text: string,
    verification: string,
    preconditions: string[] = [],
  ) =>
    result.nextSteps.push({
      ...finding(code, text),
      kind,
      preconditions,
      verificationCriteria: [verification],
      capabilityLimitations: [
        'Current adapters do not provide a safe write or retry capability.',
      ],
    });
  const hypothesis = (code: string, text: string, checks: string[]) =>
    result.hypotheses.push({
      ...finding(code, text),
      contradictingEvidenceRefs: [],
      uncertainty: 'unsubstantiated',
      missingChecks: checks,
      origin: 'rule',
    });
  let immediate = false;
  let delay = configuration.thresholds.uncertaintySeconds;
  switch (input.exceptionClass) {
    case 'inventory_mismatch': {
      const f = input.facts;
      result.facts.push(
        finding(
          'reported_availability',
          `The left source reported ${f.leftAvailable ?? 'unknown'} ${f.leftUnit}; the right source reported ${f.rightAvailable ?? 'unknown'} ${f.rightUnit}.`,
        ),
      );
      result.constraints.push(
        'Quantities describe observed availability. Oversold orders, lost revenue and synchronization failure are not established.',
      );
      if (f.authority === null)
        result.constraints.push(
          'No stock authority is configured; correction direction is unknown.',
        );
      if (decision.decision === 'detect') {
        const difference =
          decimalUnits(f.leftAvailable!) - decimalUnits(f.rightAvailable!);
        result.facts.push(
          finding(
            'signed_difference',
            `Left minus right availability is ${decimalString(difference)} ${f.leftUnit}.`,
          ),
        );
        result.impact.observed.push(
          finding(
            'quantity_mismatch',
            'Fresh observations of equivalent stock pools disagree.',
          ),
        );
        result.summary =
          'Equivalent stock pools report different available quantities.';
        if (decision.reason === 'oversell_risk') {
          result.impact.exposedQuantity = decimalString(
            f.sellingSource === 'left' ? difference : -difference,
          );
          result.impact.unit = f.leftUnit;
          result.summary = `Selling availability exceeds the configured authority by ${result.impact.exposedQuantity} ${f.leftUnit}.`;
          result.impact.potential.push(
            finding(
              'oversell_exposure',
              'Excess selling availability creates potential oversell exposure.',
            ),
          );
        }
        hypothesis(
          'stock_semantics_or_updates',
          'Stock allocation, pool configuration or delayed updates may explain the difference.',
          [
            'Inspect source update history and allocation semantics.',
            'Check synchronization job evidence before attributing a cause.',
          ],
        );
      }
      immediate = decision.decision === 'detect';
      step(
        'read_investigate',
        'reread_inventory',
        'Reread both mapped stock pools through scoped inventory reads.',
        'Fresh complete observations agree within the configured tolerance.',
      );
      if (decision.decision === 'detect' && f.authority !== null)
        step(
          'manual_intervention',
          'manual_inventory_review',
          `Ask an authorized operator to review correction against the ${f.authority} authority.`,
          'Reread both equivalent pools after correction and verify the intended quantity.',
          [
            'Confirm current mapping, authority and available-stock semantics.',
            'Obtain current observations before correcting.',
          ],
        );
      else
        step(
          'manual_intervention',
          'review_mapping_authority',
          'Review mappings, stock units and authority before choosing a correction direction.',
          'Explicit mappings and configured authority support a fresh comparison.',
        );
      break;
    }
    case 'sync_failure': {
      const f = input.facts;
      result.summary = 'The connection read needs investigation.';
      result.facts.push(
        finding(
          'scan_result',
          `The ${f.capability} scan reported ${f.status}; completeness is ${f.scanComplete ? 'complete' : 'incomplete'}${f.errorCode ? `; error code is ${f.errorCode}` : ''}.`,
        ),
      );
      result.constraints.push(
        'A failed or incomplete scan does not prove deletion or failure of a related write.',
      );
      if (decision.decision === 'detect')
        result.impact.observed.push(
          finding(
            'read_unavailable',
            'The requested scan did not complete successfully.',
          ),
        );
      hypothesis(
        'connection_access_or_provider',
        'Access configuration or provider availability may explain the failed read.',
        [
          'Inspect credential ownership and grants for access errors.',
          'Check provider status, adapter version and retry-after advice.',
        ],
      );
      if (decision.reason === 'access_lost')
        result.facts.push(
          finding(
            'access_lost',
            'The provider rejected Luma’s credentials or grants, so the connection stopped reading.',
          ),
        );
      immediate = ['hard_read_failure', 'access_lost'].includes(
        decision.reason,
      );
      step(
        immediate ? 'manual_intervention' : 'read_investigate',
        'restore_complete_scan',
        immediate
          ? 'Ask the connection owner to inspect grants, credentials or adapter compatibility.'
          : 'Request a read-only refresh after provider retry-after and backoff.',
        'A new complete scan of the same capability and scope advances the checkpoint.',
        [
          'Do not repeatedly retry authorization errors.',
          'Respect provider retry-after and read limits.',
        ],
      );
      break;
    }
    case 'stuck_fulfillment': {
      const f = input.facts;
      result.summary = 'The fulfillment operation needs a progress review.';
      result.facts.push(
        finding(
          'operation_status',
          `The operation reported ${f.status}; recorded quantity is ${f.quantity ?? 'unknown'} ${f.unit}.`,
        ),
      );
      result.facts.push(
        finding(
          'progress_basis',
          `Last recorded progress is ${f.lastProgressAt ?? 'unknown'}, based on ${f.progressBasis}.`,
        ),
      );
      result.constraints.push(
        'The progress timestamp is a proxy, not proof of warehouse inactivity.',
        'A label or closed work item does not prove shipment. Other split operations cannot settle this operation.',
      );
      if (decision.decision === 'detect')
        result.impact.potential.push(
          finding(
            'fulfillment_delay',
            'The affected operation may delay delivery; delivery cost and delay duration are unknown.',
          ),
        );
      hypothesis(
        'fulfillment_blocker',
        'Stock, carrier data or warehouse processing may be blocking progress.',
        [
          'Inspect this operation and its mapped order lines.',
          'Confirm hold/schedule eligibility and shipment identity.',
        ],
      );
      immediate = decision.decision === 'detect'; // Current adapters have no safe shipment retry.
      delay = configuration.thresholds.stuckSeconds;
      step(
        'manual_intervention',
        'inspect_fulfillment',
        'Ask the warehouse owner to inspect the operation and reread its order and shipments.',
        'Fresh shipment evidence proves the intended line quantities shipped or a reviewed cancellation disposition.',
        ['Reconcile ambiguous shipment effects before any retry.'],
      );
      break;
    }
    case 'workflow_failure': {
      const f = input.facts;
      result.summary =
        f.effect === 'unknown'
          ? 'The workflow effect is uncertain and requires reconciliation.'
          : 'Review the durable workflow step outcome.';
      result.facts.push(
        finding(
          'durable_step',
          `Step ${f.stepKey} reported ${f.status} on attempt ${f.attempt}; effect certainty is ${f.effect}.`,
        ),
      );
      result.constraints.push(
        'A worker crash or restart does not prove whether an external effect occurred.',
      );
      immediate = decision.decision === 'detect';
      if (f.effect === 'unknown') {
        result.impact.potential.push(
          finding(
            'duplicate_effect_risk',
            'Retrying before reconciliation could duplicate an external effect.',
          ),
        );
        step(
          'read_investigate',
          'reconcile_execution',
          'Reconcile the linked execution using read-only authoritative checks. Do not redispatch.',
          'Linked execution verification proves the intended business postcondition.',
          ['Preserve the logical idempotency key and execution identity.'],
        );
      } else
        step(
          'manual_intervention',
          'inspect_workflow',
          'Inspect the durable step, dependency failures and current business preconditions.',
          'A durable successful step and fresh business evidence establish recovery.',
          ['No workflow redispatch capability is currently registered.'],
        );
      hypothesis(
        'workflow_dependency_or_completion',
        'A dependency failure or lost completion persistence may explain the step outcome.',
        ['Inspect durable failure and linked execution evidence.'],
      );
      break;
    }
  }
  if (decision.decision === 'defer') {
    result.summary =
      'Evidence is insufficient to establish the current exception condition.';
    result.constraints.unshift(decision.reason);
    // Uncertain observations cannot establish a cause or support correction.
    result.hypotheses = [];
    result.nextSteps = result.nextSteps.filter(
      (s) => s.kind === 'read_investigate',
    );
    step(
      'manual_intervention',
      'investigate_missing_evidence',
      'Review missing evidence, mappings and current source state.',
      'Complete authoritative evidence supports reevaluation.',
    );
  }
  if (decision.decision === 'clear') {
    result.summary =
      'The current evidence does not meet the detection rule; the incident still requires lifecycle verification.';
    result.hypotheses = [];
    result.impact.potential = [];
    result.nextSteps = [];
    step(
      'read_investigate',
      'verify_lifecycle',
      'Request verification through the incident lifecycle owner.',
      'Independent authoritative verification proves the class postcondition.',
    );
  }
  const dueAt = new Date(
    Date.parse(snapshot.firstDetectedAt) + delay * 1000,
  ).toISOString();
  result.attention = {
    suggested:
      (decision.decision === 'detect' && (immediate || now >= dueAt)) ||
      snapshot.reviewRequired,
    reason: snapshot.reviewRequired
      ? 'uncertainty_window_elapsed'
      : immediate && decision.decision === 'detect'
        ? 'operator_review_required'
        : decision.decision === 'detect' && now >= dueAt
          ? 'review_window_elapsed'
          : 'within_review_window',
    evidenceRefs: refs,
    dueAt:
      decision.decision === 'detect'
        ? immediate
          ? snapshot.firstDetectedAt
          : dueAt
        : null,
  };

  return result;
}
