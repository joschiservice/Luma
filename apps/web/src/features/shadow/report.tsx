import './shadow.css';

import { formatCalendarDate, formatPercent } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
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
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { workspaceDateValue } from '@luma/ui/lib/timezone';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useContext, useId, useState } from 'react';

import {
  type ShadowComparison,
  shadowError,
  type ShadowReport as Report,
  shadowReportOptions,
  shadowWindow,
} from './data';
import { actualLabels, ShadowResult } from './result';

const metrics = [
  [
    'agreementWithOperator',
    m.shadow_metric_agreement,
    m.shadow_metric_agreement_description,
  ],
  [
    'falsePositiveActionRate',
    m.shadow_metric_unnecessary,
    m.shadow_metric_unnecessary_description,
  ],
  [
    'missedEligibleCases',
    m.shadow_metric_missed,
    m.shadow_metric_missed_description,
  ],
  [
    'predictedVsActualOutcome',
    m.shadow_metric_prediction,
    m.shadow_metric_prediction_description,
  ],
  [
    'projectedAutonomousResolutionRate',
    m.shadow_metric_autonomous,
    m.shadow_metric_autonomous_description,
  ],
  [
    'projectedUnnecessaryHumanInterventionRate',
    m.shadow_metric_avoidable,
    m.shadow_metric_avoidable_description,
  ],
  ['operatorTrust', m.shadow_metric_trust, m.shadow_metric_trust_description],
] as const satisfies readonly (readonly [
  keyof Report['metrics'],
  () => string,
  () => string,
])[];

/** Compares the latest evaluation per case for a Workflow within an explicit workspace date range. */
export function ShadowReport({
  organizationId,
  workflow,
}: {
  organizationId: string;
  workflow: string;
}) {
  const id = useId();
  const timeZone = useContext(WorkspaceTimezone);
  const [dates, setDates] = useState(() => ({
    from: workspaceDateValue(new Date(Date.now() - 29 * 86400000), timeZone),
    to: workspaceDateValue(new Date(), timeZone),
  }));
  const [window, setWindow] = useState(() =>
    shadowWindow(workflow, dates.from, dates.to, timeZone),
  );
  const [error, setError] = useState('');
  const query = useQuery(shadowReportOptions(organizationId, window));

  return (
    <Card
      as="section"
      id="shadow-report"
      className="workflow-section shadow-report"
      aria-labelledby={`${id}-title`}
    >
      <CardHeader className="workflows-heading">
        <div>
          <p className="shadow-label">{m.shadow_preview_label()}</p>
          <h2 id={`${id}-title`}>{m.shadow_report_title()}</h2>
        </div>
        <RefreshButton
          label={m.shadow_report_refresh()}
          refreshing={query.isFetching}
          onClick={() => void query.refetch()}
        />
      </CardHeader>
      <p>{m.shadow_report_description()}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            setWindow(shadowWindow(workflow, dates.from, dates.to, timeZone));
            setError('');
          } catch (error) {
            setError(
              error instanceof Error
                ? error.message
                : m.shadow_report_dates_invalid(),
            );
          }
        }}
      >
        <FieldGroup className="shadow-date-fields">
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor={`${id}-from`}>
              {m.shadow_report_from({ timeZone })}
            </FieldLabel>
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
            <FieldLabel htmlFor={`${id}-to`}>
              {m.shadow_report_through({ timeZone })}
            </FieldLabel>
            <Input
              id={`${id}-to`}
              type="date"
              value={dates.to}
              aria-invalid={!!error}
              onChange={(e) => setDates({ ...dates, to: e.target.value })}
              required
            />
          </Field>
          <Button type="submit">{m.shadow_report_apply()}</Button>
        </FieldGroup>
        {error ? <p role="alert">{error}</p> : null}
      </form>
      <p className="shadow-meta">
        {m.shadow_report_range({
          from: formatCalendarDate(
            workspaceDateValue(new Date(window.since), timeZone),
          ),
          to: formatCalendarDate(
            workspaceDateValue(
              new Date(Date.parse(window.until) - 1),
              timeZone,
            ),
          ),
          timeZone,
        })}
      </p>
      {query.error ? (
        <CaseNotice error title={m.shadow_report_failed()}>
          {shadowError(query.error)}
        </CaseNotice>
      ) : query.isPending ? (
        <p role="status">{m.shadow_report_loading()}</p>
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
function ShadowReportResults({
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
          {m.shadow_report_tested({ count: report.metrics.evaluations })}
        </strong>{' '}
        · {m.shadow_report_reviewed({ count: report.metrics.reviewed })}
      </p>
      <dl className="shadow-metrics">
        {metrics.map(([key, title, description]) => {
          const metric = report.metrics[key];

          return (
            <div key={key}>
              <dt>{title()}</dt>
              <dd>
                {metric.rate === null
                  ? m.shadow_report_not_enough_data()
                  : formatPercent(metric.rate)}
              </dd>
              <dd className="shadow-metric-description">
                {m.shadow_metric_count({
                  numerator: metric.numerator,
                  denominator: metric.denominator,
                  description: description(),
                })}
              </dd>
            </div>
          );
        })}
      </dl>
      {!report.items.length ? (
        <CaseNotice title={m.shadow_report_empty_title()}>
          {m.shadow_report_empty_description()}
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
      <div className="workflows-heading">
        <h3>
          {m.shadow_report_issue_title({
            id: item.evaluation.incidentId.slice(0, 8),
          })}
        </h3>
        <Link
          to="/app/$organizationId/exceptions/$exceptionId"
          params={{
            organizationId,
            exceptionId: item.evaluation.incidentId,
          }}
          search={{ view: 'active', shadow: item.evaluation.workflow }}
          hash="shadow"
        >
          {item.review
            ? m.shadow_report_open_issue()
            : m.shadow_report_review_link()}
        </Link>
      </div>
      <p className="shadow-meta">
        {m.shadow_report_card_predicted({
          value:
            item.evaluation.simulation.predictedOutcome === 'passed'
              ? m.shadow_predicted_passed_short()
              : m.shadow_predicted_inconclusive(),
        })}{' '}
        ·{' '}
        {m.shadow_report_card_actual({
          value: item.actual
            ? actualLabels[item.actual.outcome]()
            : m.shadow_actual_unknown(),
        })}{' '}
        ·{' '}
        {item.review
          ? m.shadow_report_card_reviewed()
          : m.shadow_report_card_awaiting()}
      </p>
      <Disclosure onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>{m.shadow_report_card_details()}</summary>
        {open ? <ShadowResult item={item} /> : null}
      </Disclosure>
    </article>
  );
}
