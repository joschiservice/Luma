import './shadow.css';

import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { caseLabel } from '@luma/ui/components/issues/case-investigation';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useState } from 'react';

import {
  candidateAction,
  type ShadowComparison,
  type ShadowReview,
} from './data';

type Evaluation = ShadowComparison['evaluation'];

const eligibilityLabels = {
  eligible: m.shadow_eligibility_eligible,
  ineligible: m.shadow_eligibility_ineligible,
  stale_evidence: m.shadow_eligibility_stale_evidence,
  no_candidate: m.shadow_eligibility_no_candidate,
} satisfies Record<Evaluation['eligibility'], () => string>;

const rulesLabels = {
  allowed: m.shadow_rules_allowed,
  denied: m.shadow_rules_denied,
  approval_required: m.shadow_rules_approval_required,
} satisfies Record<NonNullable<Evaluation['policy']>['outcome'], () => string>;

const reasonLabels: Record<string, (() => string) | undefined> = {
  authorized: m.shadow_reason_authorized,
  permission_denied: m.shadow_reason_permission_denied,
  capability_unavailable: m.shadow_reason_capability_unavailable,
  stale_intent: m.shadow_reason_stale_intent,
  approval_required: m.shadow_reason_approval_required,
  approval_rejected: m.shadow_reason_approval_rejected,
};

const predictedLabels = {
  passed: m.shadow_predicted_passed,
  inconclusive: m.shadow_predicted_inconclusive,
} satisfies Record<Evaluation['simulation']['predictedOutcome'], () => string>;

/** Short labels for the confirmed outcome; shared with the comparison report. */
export const actualLabels = {
  passed: m.shadow_actual_passed,
  failed: m.shadow_actual_failed,
} satisfies Record<
  NonNullable<ShadowComparison['actual']>['outcome'],
  () => string
>;

const trustLabels = {
  trust: m.shadow_trust_trust,
  distrust: m.shadow_trust_distrust,
  unsure: m.shadow_trust_unsure,
} satisfies Record<
  NonNullable<NonNullable<ShadowComparison['review']>['feedback']>,
  () => string
>;

function actionSummary(action: NonNullable<ShadowReview['operatorAction']>) {
  return m.shadow_action_summary({
    action:
      action.capability === 'orders.shipping-method.write'
        ? m.shadow_action_set_shipping_method()
        : caseLabel(action.capability),
    kind: action.target.kind,
    id: action.target.id,
  });
}

/** Presents conditional predictions separately from recorded operator and authoritative outcomes. */
export function ShadowResult({ item }: { item: ShadowComparison }) {
  const { evaluation, actual, review } = item;
  const [expanded, setExpanded] = useState(false);
  const action = candidateAction(evaluation);
  const version = evaluation.candidate?.version;
  const reason = evaluation.policy?.reason;

  return (
    <div className="shadow-result">
      <p className="shadow-label">{m.shadow_preview_label()}</p>
      <p className="shadow-meta">
        <WorkspaceDate value={evaluation.createdAt} />
        {typeof version === 'string'
          ? ` · ${m.shadow_result_workflow_version({ version })}`
          : ''}
      </p>
      <dl className="shadow-facts">
        <div>
          <dt>{m.shadow_result_fits_label()}</dt>
          <dd>{eligibilityLabels[evaluation.eligibility]()}</dd>
        </div>
        <div>
          <dt>{m.shadow_result_rules_label()}</dt>
          <dd>
            {evaluation.policy
              ? rulesLabels[evaluation.policy.outcome]()
              : m.shadow_result_rules_none()}
          </dd>
        </div>
        <div>
          <dt>{m.shadow_result_predicted_label()}</dt>
          <dd>{predictedLabels[evaluation.simulation.predictedOutcome]()}</dd>
        </div>
        <div>
          <dt>{m.shadow_result_actual_label()}</dt>
          <dd>
            {actual
              ? actualLabels[actual.outcome]()
              : m.shadow_actual_unknown()}
          </dd>
        </div>
      </dl>
      {reason ? (
        <p>
          {reasonLabels[reason]?.() ??
            m.shadow_reason_other({ reason: caseLabel(reason) })}
        </p>
      ) : null}
      <h4>{m.shadow_result_proposed_title()}</h4>
      {action ? (
        <>
          <p>{actionSummary(action)}</p>
          <ActionFields
            fields={action.parameters}
            empty={m.shadow_result_no_details()}
          />
        </>
      ) : (
        <p>{m.shadow_result_no_change()}</p>
      )}
      <h4>{m.shadow_result_effects_title()}</h4>
      <ActionFields
        fields={evaluation.simulation.effects}
        empty={m.shadow_result_no_effects()}
      />
      {evaluation.simulation.assumptions.length ? (
        <>
          <h4>{m.shadow_result_assumptions_title()}</h4>
          <ul>
            {evaluation.simulation.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </>
      ) : null}
      {actual ? (
        <p>
          {rich(m.shadow_result_checked, {
            count: actual.evidenceRefs.length,
            time: <WorkspaceDate value={actual.occurredAt} />,
          })}
        </p>
      ) : null}
      {review ? (
        <div className="shadow-recorded">
          <h4>{m.shadow_result_review_title()}</h4>
          <dl className="shadow-facts">
            <div>
              <dt>{m.shadow_result_review_needed_label()}</dt>
              <dd>{review.actionNeeded ? m.common_yes() : m.common_no()}</dd>
            </div>
            <div>
              <dt>{m.shadow_result_review_fits_label()}</dt>
              <dd>{review.eligible ? m.common_yes() : m.common_no()}</dd>
            </div>
            <div>
              <dt>{m.shadow_result_review_trust_label()}</dt>
              <dd>
                {review.feedback
                  ? trustLabels[review.feedback]()
                  : m.shadow_trust_none()}
              </dd>
            </div>
          </dl>
          {review.operatorAction ? (
            <>
              <p>{actionSummary(review.operatorAction)}</p>
              <ActionFields
                fields={review.operatorAction.expectedPostcondition}
                empty={m.shadow_result_review_no_expected()}
              />
            </>
          ) : (
            <p>{m.shadow_result_review_no_action()}</p>
          )}
          <p>
            {rich(m.shadow_result_review_evidence, {
              count: review.evidenceRefs.length,
              time: <WorkspaceDate value={review.occurredAt} />,
            })}
          </p>
        </div>
      ) : null}
      <Disclosure onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>{m.shadow_result_details()}</summary>
        <p>{m.shadow_result_test_id({ id: evaluation.id })}</p>
        {expanded ? (
          <pre>
            {JSON.stringify(
              {
                candidate: evaluation.candidate,
                diagnosis: evaluation.diagnosis,
                actual,
                review,
              },
              null,
              2,
            )}
          </pre>
        ) : null}
      </Disclosure>
    </div>
  );
}

/** Displays scalar business fields as readable labels and values. */
function ActionFields({
  fields,
  empty,
}: {
  fields: Record<string, string | number | boolean | null>;
  empty: string;
}) {
  return Object.keys(fields).length ? (
    <dl className="shadow-facts">
      {Object.entries(fields).map(([key, value]) => (
        <div key={key}>
          <dt>{caseLabel(key.replace(/([a-z])([A-Z])/g, '$1 $2'))}</dt>
          <dd>
            {value === null
              ? m.common_none()
              : typeof value === 'boolean'
                ? value
                  ? m.common_yes()
                  : m.common_no()
                : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <p>{empty}</p>
  );
}
