import type {
  CaseDetail,
  CaseProgress,
  CaseReview,
  Diagnosis,
} from '@luma/api-contract';
import { formatExactQuantity, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useContext } from 'react';

import { Button } from '../primitives/button';
import { Disclosure } from '../primitives/disclosure';
import {
  caseSummaryText,
  quantityLabel,
  sourceLabel,
  unitLabel,
} from './case-presentation';
import { IssuePageNavigation } from './issue-section';

/** Rewrites known inventory steps in plain language; other steps keep the investigation’s text. */
function stepLabel(step: Diagnosis['nextSteps'][number]) {
  switch (step.code) {
    case 'reread_inventory':
      return m.issues_overview_step_reread_inventory();
    case 'manual_inventory_review':
      return m.issues_overview_step_manual_inventory_review();
    case 'review_mapping_authority':
      return m.issues_overview_step_review_mapping_authority();
    default:
      return step.text;
  }
}

/** Summarizes recorded impact and the next action, retaining detailed checks in a disclosure. */
export function IssueOverview({
  item,
  unconfirmed = false,
  children,
  review,
  lifecycle,
}: {
  item: CaseDetail;
  unconfirmed?: boolean;
  children?: ReactNode;
  review?: CaseReview | undefined;
  lifecycle?: CaseProgress | undefined;
}) {
  const navigate = useContext(IssuePageNavigation);
  const diagnosis = item.diagnosis;
  const historical =
    item.freshness === 'stale' ||
    diagnosis?.superseded ||
    item.state === 'resolved';
  const current =
    !unconfirmed &&
    !historical &&
    diagnosis &&
    !['pending', 'failed'].includes(item.diagnosisStatus) &&
    !['pending', 'failed'].includes(diagnosis.status);
  const needsReview = Boolean(
    current &&
    navigate &&
    review?.proposal?.available &&
    review.proposal.policy?.outcome === 'approval_required' &&
    !review.proposal.approval &&
    review.permittedDecisions.includes('approve'),
  );
  const steps = current ? diagnosis.nextSteps : [];
  const quantity = diagnosis?.impact.exposedQuantity;
  const formattedQuantity = quantity != null ? quantityLabel(quantity) : null;
  const unit =
    quantity != null && diagnosis?.impact.unit
      ? unitLabel(diagnosis.impact.unit, quantity)
      : null;
  const summary = caseSummaryText(
    item.diagnosisStatus === 'pending'
      ? item.summary
      : (diagnosis?.summary ?? item.summary),
  );
  // The issue title already sits above the overview; repeat the conclusion only when it adds to it.
  const sameAsTitle =
    summary.replace(/\.+$/, '') ===
    caseSummaryText(item.summary).replace(/\.+$/, '');
  const limitations = [
    ...new Set(
      steps
        .flatMap((step) => step.capabilityLimitations)
        .map((text) =>
          text ===
          'Current adapters do not provide a safe write or retry capability.'
            ? m.issues_overview_no_automatic_fix()
            : text,
        ),
    ),
  ];

  const products = new Map<
    string,
    { title: string | null; sku: string | null; sources: Set<string> }
  >();
  for (const product of item.productIdentities ?? []) {
    const key = JSON.stringify([product.title, product.sku]);
    const group = products.get(key) ?? {
      title: product.title,
      sku: product.sku,
      sources: new Set<string>(),
    };
    group.sources.add(sourceLabel(product.source));
    products.set(key, group);
  }

  return (
    <div className="issue-overview">
      <div className="issue-overview-summary">
        {sameAsTitle ? null : (
          <p className="issue-overview-conclusion">{summary}</p>
        )}
        <div className="issue-overview-product case-caption">
          {products.size ? (
            [...products.entries()].map(([key, product]) => (
              <p key={key}>
                {product.title ? <span>{product.title}</span> : null}
                {product.title && product.sku ? ' · ' : ''}
                {product.sku ? (
                  <span>{m.issues_overview_sku({ sku: product.sku })}</span>
                ) : null}
                <span> · {[...product.sources].join(' · ')}</span>
              </p>
            ))
          ) : (
            <p>
              {item.subject.kind === 'sku'
                ? m.issues_overview_sku({
                    sku: item.subject.label ?? m.common_not_reported(),
                  })
                : m.issues_overview_subject({
                    id: item.subject.label ?? m.common_not_reported(),
                  })}
            </p>
          )}
        </div>
        {formattedQuantity !== null ? (
          <p className="issue-overview-impact">
            <span>
              {historical || unconfirmed
                ? m.issues_exposure_label_recorded()
                : m.issues_exposure_label()}
            </span>
            {': '}
            <strong>
              {formattedQuantity}
              {unit ? ` ${unit}` : ''}
            </strong>
            {' · '}
            {item.class === 'inventory_mismatch'
              ? m.issues_overview_overselling_unconfirmed()
              : m.issues_overview_losses_unconfirmed()}
          </p>
        ) : null}
      </div>
      {item.detectionLimits ? (
        <p>
          {item.class === 'inventory_mismatch'
            ? m.issues_detection_stock_limits({
                tolerance: formatExactQuantity(
                  item.detectionLimits.inventoryTolerance,
                ),
                window: formatNumber(item.detectionLimits.propagationSeconds),
                oversell: formatNumber(
                  item.detectionLimits.oversellPropagationSeconds,
                ),
              })
            : item.class === 'stuck_fulfillment'
              ? m.issues_detection_fulfillment_limit({
                  limit: formatNumber(item.detectionLimits.stuckSeconds),
                })
              : item.class === 'stock_sync_stall'
                ? m.issues_detection_stall_limits({
                    window: formatNumber(item.detectionLimits.stallSeconds),
                    count: formatNumber(item.detectionLimits.stallMinPositions),
                    share: formatNumber(item.detectionLimits.stallSharePercent),
                  })
                : null}
        </p>
      ) : null}
      {children}
      <div className="issue-overview-action">
        <h3 className="issue-overview-action-label">
          {m.issues_overview_next_action()}
        </h3>
        {needsReview ? (
          <Button onClick={() => navigate?.('resolution')}>
            {m.issues_review_proposed_change()}
          </Button>
        ) : null}
        {item.state === 'resolved' ? (
          <p>
            {item.resolution === 'verified'
              ? m.issues_overview_verified()
              : m.issues_overview_closed()}
          </p>
        ) : lifecycle?.workflowRuns?.length ? (
          <p>{m.issues_overview_workflow()}</p>
        ) : steps[0] ? (
          <>
            <p className="issue-overview-next">{stepLabel(steps[0])}</p>
            {steps[1] ? (
              <p>
                <span className="case-caption">
                  {m.issues_overview_then()}{' '}
                </span>
                {stepLabel(steps[1])}
              </p>
            ) : null}
            {limitations.map((text) => (
              <p className="case-caption" key={text}>
                {text}
              </p>
            ))}
            <Disclosure className="issue-overview-checks">
              <summary>
                <ChevronRight size={14} aria-hidden="true" />
                {m.issues_overview_checks()}
              </summary>
              {item.attention.required ? (
                <p>{item.attention.explanation}</p>
              ) : null}
              <ol>
                {steps.map((step) => (
                  <li key={step.code}>
                    <h4>{stepLabel(step)}</h4>
                    {stepLabel(step) !== step.text ? <p>{step.text}</p> : null}
                    {step.preconditions.length ? (
                      <>
                        <h5>{m.issues_step_before()}</h5>
                        <ul>
                          {step.preconditions.map((text) => (
                            <li key={text}>{text}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    <h5>{m.issues_step_expected()}</h5>
                    <ul>
                      {step.verificationCriteria.map((text) => (
                        <li key={text}>{text}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </Disclosure>
          </>
        ) : (
          <p>
            {unconfirmed
              ? m.issues_overview_unconfirmed()
              : historical
                ? m.issues_overview_historical()
                : item.diagnosisStatus === 'pending'
                  ? m.issues_overview_pending()
                  : m.issues_recommendation_none()}
          </p>
        )}
      </div>
    </div>
  );
}
