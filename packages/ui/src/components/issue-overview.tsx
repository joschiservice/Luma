import type { CaseDetail, Diagnosis } from '@luma/api-contract';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

/** Removes insignificant decimal zeros without rounding recorded quantities. */
function quantityLabel(value: string) {
  return value.includes('.')
    ? value.replace(/0+$/, '').replace(/\.$/, '')
    : value;
}

function stepLabel(step: Diagnosis['nextSteps'][number]) {
  switch (step.code) {
    case 'reread_inventory':
      return 'Check current stock in both systems.';
    case 'manual_inventory_review':
      return 'If the difference remains, ask an authorized operator to review the correction.';
    case 'review_mapping_authority':
      return 'Confirm the stock mappings, units, and source of truth before choosing a correction.';
    default:
      return step.text;
  }
}

/** Summarizes recorded impact and the next action, retaining detailed checks in a disclosure. */
export function IssueOverview({
  item,
  unconfirmed = false,
  children,
}: {
  item: CaseDetail;
  unconfirmed?: boolean;
  children?: ReactNode;
}) {
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
  const steps = current ? diagnosis.nextSteps : [];
  const quantity = diagnosis?.impact.exposedQuantity;
  const formattedQuantity = quantity != null ? quantityLabel(quantity) : null;
  const unit =
    diagnosis?.impact.unit === 'each'
      ? formattedQuantity === '1'
        ? 'unit'
        : 'units'
      : diagnosis?.impact.unit;
  const summary = (diagnosis?.summary ?? item.summary).replace(
    /^Selling availability exceeds the configured authority by (-?\d+(?:\.\d+)?) (.+)\.$/,
    (_, amount: string, measure: string) =>
      `Selling availability is ${quantityLabel(amount)} ${measure === 'each' ? (quantityLabel(amount) === '1' ? 'unit' : 'units') : measure} above the configured stock authority.`,
  );
  const limitations = [
    ...new Set(
      steps
        .flatMap((step) => step.capabilityLimitations)
        .map((text) =>
          text ===
          'Current adapters do not provide a safe write or retry capability.'
            ? 'Automatic correction and retries are not available for this issue.'
            : text,
        ),
    ),
  ];

  const products = new Map<
    string,
    { title: string | null; sku: string | null; sources: Set<string> }
  >();
  const sourceNames: Record<string, string> = {
    shopify: 'Shopify',
    jtl: 'JTL',
    'jtl-onprem': 'JTL-Wawi',
    'jtl-cloud': 'JTL Cloud',
  };
  for (const product of item.productIdentities ?? []) {
    const key = JSON.stringify([product.title, product.sku]);
    const group = products.get(key) ?? {
      title: product.title,
      sku: product.sku,
      sources: new Set<string>(),
    };
    group.sources.add(sourceNames[product.source] ?? product.source);
    products.set(key, group);
  }

  return (
    <div className="issue-overview">
      <div className="issue-overview-summary">
        <p className="issue-overview-conclusion">{summary}</p>
        <div className="issue-overview-product case-caption">
          {products.size ? (
            [...products.entries()].map(([key, product]) => (
              <p key={key}>
                {product.title ? <span>{product.title}</span> : null}
                {product.title && product.sku ? ' · ' : ''}
                {product.sku ? <span>SKU: {product.sku}</span> : null}
                <span> · {[...product.sources].join(' · ')}</span>
              </p>
            ))
          ) : (
            <p>
              {item.subject.kind === 'sku' ? 'SKU ID' : 'Subject ID'}:{' '}
              {item.subject.id}
            </p>
          )}
        </div>
        {formattedQuantity !== null ? (
          <p className="issue-overview-impact">
            <span>
              {historical || unconfirmed
                ? 'Recorded potential exposure'
                : 'Potential exposure'}
            </span>
            {': '}
            <strong>
              {formattedQuantity}
              {unit ? ` ${unit}` : ''}
            </strong>
            {' · '}
            {item.class === 'inventory_mismatch'
              ? 'Overselling has not been confirmed.'
              : 'Does not confirm realized losses.'}
          </p>
        ) : null}
      </div>
      {children}
      <div className="issue-overview-action">
        <h3 className="issue-overview-action-label">Next action</h3>
        {steps[0] ? (
          <>
            <p className="issue-overview-next">{stepLabel(steps[0])}</p>
            {steps[1] ? (
              <p>
                <span className="case-caption">Then: </span>
                {stepLabel(steps[1])}
              </p>
            ) : null}
            {limitations.map((text) => (
              <p className="case-caption" key={text}>
                {text}
              </p>
            ))}
            <details className="issue-overview-checks">
              <summary>
                <ChevronRight size={14} aria-hidden="true" />
                Checks and verification
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
                        <h5>Before proceeding</h5>
                        <ul>
                          {step.preconditions.map((text) => (
                            <li key={text}>{text}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    <h5>Expected result and verification</h5>
                    <ul>
                      {step.verificationCriteria.map((text) => (
                        <li key={text}>{text}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </details>
          </>
        ) : (
          <p>
            {unconfirmed
              ? 'Reconnect or refresh to confirm the next action.'
              : historical
                ? 'These findings are historical. Check fresh observations before choosing a correction.'
                : item.diagnosisStatus === 'pending'
                  ? 'Wait for the investigation to finish before choosing a correction.'
                  : 'No current recommendation is available.'}
          </p>
        )}
      </div>
    </div>
  );
}
