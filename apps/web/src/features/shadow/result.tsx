import './shadow.css';

import { caseLabel } from '@luma/ui/components/issues/case-investigation';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useState } from 'react';

import { candidateAction, type ShadowComparison } from './data';

/** Presents conditional predictions separately from recorded operator and authoritative outcomes. */
export function ShadowResult({ item }: { item: ShadowComparison }) {
  const { evaluation, actual, review } = item;
  const [expanded, setExpanded] = useState(false);
  const action = candidateAction(evaluation);
  const version = evaluation.candidate?.version;

  return (
    <div className="shadow-result">
      <p className="shadow-label">Shadow — not executed</p>
      <p className="shadow-meta">
        <time dateTime={evaluation.createdAt}>
          <WorkspaceDate value={evaluation.createdAt} />
        </time>
        {typeof version === 'string' ? ` · Workflow ${version}` : ''}
      </p>
      <dl className="shadow-facts">
        <div>
          <dt>Eligibility</dt>
          <dd>{caseLabel(evaluation.eligibility)}</dd>
        </div>
        <div>
          <dt>Policy</dt>
          <dd>
            {evaluation.policy
              ? caseLabel(evaluation.policy.outcome)
              : 'No candidate to assess'}
          </dd>
        </div>
        <div>
          <dt>Predicted outcome</dt>
          <dd>
            {evaluation.simulation.predictedOutcome === 'passed'
              ? 'Pass, if assumptions hold'
              : 'Inconclusive'}
          </dd>
        </div>
        <div>
          <dt>Actual outcome</dt>
          <dd>{actual ? caseLabel(actual.outcome) : 'Not observed'}</dd>
        </div>
      </dl>
      {evaluation.policy ? (
        <p>Policy reason: {caseLabel(evaluation.policy.reason)}.</p>
      ) : null}
      <h4>Proposed action</h4>
      {action ? (
        <>
          <p>
            {action.capability === 'orders.shipping-method.write'
              ? 'Set shipping method'
              : caseLabel(action.capability)}{' '}
            · {action.target.kind} {action.target.id}
          </p>
          <ActionFields
            fields={action.parameters}
            empty="No additional parameters."
          />
        </>
      ) : (
        <p>No bound candidate was available for this case and Workflow.</p>
      )}
      <h4>Predicted effects</h4>
      <ActionFields
        fields={evaluation.simulation.effects}
        empty="No effects predicted."
      />
      {evaluation.simulation.assumptions.length ? (
        <>
          <h4>Prediction assumptions</h4>
          <ul>
            {evaluation.simulation.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </>
      ) : null}
      {actual ? (
        <p>
          Observed <WorkspaceDate value={actual.occurredAt} /> ·{' '}
          {actual.evidenceRefs.length} evidence references ·{' '}
          {actual.evaluatorVersion}
        </p>
      ) : null}
      {review ? (
        <div className="shadow-recorded">
          <h4>Operator comparison recorded</h4>
          <p>
            Action {review.actionNeeded ? 'needed' : 'not needed'} ·{' '}
            {review.eligible ? 'Eligible case' : 'Ineligible case'} · Feedback:{' '}
            {review.feedback ?? 'Not provided'}
          </p>
          {review.operatorAction ? (
            <>
              <p>
                {review.operatorAction.capability ===
                'orders.shipping-method.write'
                  ? 'Set shipping method'
                  : caseLabel(review.operatorAction.capability)}{' '}
                · {review.operatorAction.target.kind}{' '}
                {review.operatorAction.target.id}
              </p>
              <ActionFields
                fields={review.operatorAction.expectedPostcondition}
                empty="No expected result recorded."
              />
            </>
          ) : (
            <p>Operator action not observed.</p>
          )}
          <p>
            {review.evidenceRefs.length} evidence references ·{' '}
            <WorkspaceDate value={review.occurredAt} />
          </p>
        </div>
      ) : null}
      <Disclosure onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>Bound inputs and evidence</summary>
        <p>Evaluation: {evaluation.id}</p>
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
export function ActionFields({
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
          <dd>{value === null ? 'None' : String(value)}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <p>{empty}</p>
  );
}
