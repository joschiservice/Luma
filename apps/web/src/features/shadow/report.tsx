import { CaseNotice } from '@luma/ui/components/issues/case-investigation';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardHeader } from '@luma/ui/components/primitives/card';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';

import {
  type ShadowComparison,
  shadowError,
  type ShadowReport as Report,
  shadowReportOptions,
  shadowWindow,
} from './data';
import { ShadowResult } from './result';

const metrics = [
  [
    'agreementWithOperator',
    'Agreement with operator',
    'Matching proposed and observed actions.',
  ],
  [
    'falsePositiveActionRate',
    'Unnecessary proposals',
    'Reviewed proposals assessed as unnecessary.',
  ],
  [
    'missedEligibleCases',
    'Missed eligible cases',
    'Eligible cases needing action without a permitted candidate.',
  ],
  [
    'predictedVsActualOutcome',
    'Prediction agreement',
    'Predictions matching authoritative outcomes.',
  ],
  [
    'projectedAutonomousResolutionRate',
    'Projected autonomous resolution',
    'Allowed candidates with a supported passing prediction.',
  ],
  [
    'projectedUnnecessaryHumanInterventionRate',
    'Potentially avoidable intervention',
    'Autonomous candidates matching observed interventions.',
  ],
  [
    'operatorTrust',
    'Operator trust',
    'Trust responses among trust and distrust feedback.',
  ],
] as const;

/** Compares the latest evaluation per case for a Playbook within an explicit UTC date range. */
export function ShadowReport({
  organizationId,
  workflow,
}: {
  organizationId: string;
  workflow: string;
}) {
  const id = useId();
  const [dates, setDates] = useState(() => ({
    from: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
  }));
  const [window, setWindow] = useState(() =>
    shadowWindow(workflow, dates.from, dates.to),
  );
  const [error, setError] = useState('');
  const query = useQuery(shadowReportOptions(organizationId, window));

  return (
    <Card
      as="section"
      id="shadow-report"
      className="playbook-section shadow-report"
      aria-labelledby={`${id}-title`}
    >
      <CardHeader className="playbooks-heading">
        <div>
          <p className="shadow-label">Shadow — not executed</p>
          <h2 id={`${id}-title`}>Shadow comparisons</h2>
        </div>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh comparisons
        </Button>
      </CardHeader>
      <p>
        Compare the latest prediction per case with operator actions and
        authoritative outcomes. Projected rates do not represent live
        resolutions.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            setWindow(shadowWindow(workflow, dates.from, dates.to));
            setError('');
          } catch (error) {
            setError(
              error instanceof Error
                ? error.message
                : 'Check the selected dates.',
            );
          }
        }}
      >
        <FieldGroup className="shadow-date-fields">
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor={`${id}-from`}>From (UTC)</FieldLabel>
            <Input
              id={`${id}-from`}
              type="date"
              value={dates.from}
              aria-invalid={!!error}
              onChange={(e) => setDates({ ...dates, from: e.target.value })}
              required
            />
          </Field>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor={`${id}-to`}>Through (UTC)</FieldLabel>
            <Input
              id={`${id}-to`}
              type="date"
              value={dates.to}
              aria-invalid={!!error}
              onChange={(e) => setDates({ ...dates, to: e.target.value })}
              required
            />
          </Field>
          <Button type="submit">Apply dates</Button>
        </FieldGroup>
        {error ? <p role="alert">{error}</p> : null}
      </form>
      <p className="shadow-meta">
        Showing {window.since.slice(0, 10)} through{' '}
        {new Date(Date.parse(window.until) - 1).toISOString().slice(0, 10)} UTC.
        Up to 500 cases; narrow the dates for larger reports.
      </p>
      {query.error ? (
        <CaseNotice error title="Comparisons unavailable">
          {shadowError(query.error)}
        </CaseNotice>
      ) : query.isPending ? (
        <p role="status">Loading comparisons…</p>
      ) : query.data ? (
        <ShadowReportResults
          report={query.data}
          organizationId={organizationId}
        />
      ) : null}
    </Card>
  );
}

/** Shows denominators and missing evidence explicitly, alongside individual case comparisons. */
export function ShadowReportResults({
  report,
  organizationId,
}: {
  report: Report;
  organizationId: string;
}) {
  return (
    <>
      <p>
        <strong>
          {report.metrics.evaluations}{' '}
          {report.metrics.evaluations === 1 ? 'case' : 'cases'} evaluated
        </strong>{' '}
        · {report.metrics.reviewed} reviewed by operators
      </p>
      <dl className="shadow-metrics">
        {metrics.map(([key, title, description]) => {
          const metric = report.metrics[key];

          return (
            <div key={key}>
              <dt>{title}</dt>
              <dd>
                {metric.rate === null
                  ? 'Not enough evidence'
                  : `${Math.round(metric.rate * 100)}%`}
              </dd>
              <dd className="shadow-metric-description">
                {metric.numerator} / {metric.denominator} · {description}
              </dd>
            </div>
          );
        })}
      </dl>
      {!report.items.length ? (
        <CaseNotice title="No Shadow evaluations in this period">
          Run an evaluation from an issue, or choose another date range.
        </CaseNotice>
      ) : (
        <div className="shadow-comparisons">
          {report.items.map((item) => (
            <ComparisonCard
              key={item.evaluation.id}
              item={item}
              organizationId={organizationId}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ComparisonCard({
  item,
  organizationId,
}: {
  item: ShadowComparison;
  organizationId: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <article>
      <div className="playbooks-heading">
        <h3>Case {item.evaluation.incidentId.slice(0, 8)}</h3>
        <Link
          to="/app/$organizationId/exceptions/$exceptionId"
          params={{
            organizationId,
            exceptionId: item.evaluation.incidentId,
          }}
          search={{ view: 'active', shadow: item.evaluation.workflow }}
          hash="shadow"
        >
          {item.review ? 'Open case' : 'Record operator comparison'}
        </Link>
      </div>
      <p className="shadow-meta">
        Predicted:{' '}
        {item.evaluation.simulation.predictedOutcome === 'passed'
          ? 'conditional pass'
          : 'inconclusive'}{' '}
        · Actual: {item.actual?.outcome ?? 'not observed'} ·{' '}
        {item.review ? 'Reviewed' : 'Awaiting operator review'}
      </p>
      <Disclosure onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>View prediction and evidence</summary>
        {open ? <ShadowResult item={item} /> : null}
      </Disclosure>
    </article>
  );
}
