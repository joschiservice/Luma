import type {
  InstalledConnection,
  OperationalMetricRequest,
  OperationalMetricResponse,
} from '@luma/api-contract';
import { caseClasses } from '@luma/api-contract';
import {
  formatCalendarDate,
  formatNumber,
  formatPercent,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { issueKind } from '@luma/ui/components/issues/case-presentation';
import { Badge } from '@luma/ui/components/primitives/badge';
import { BarChart } from '@luma/ui/components/primitives/bar-chart';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@luma/ui/components/primitives/tabs';
import {
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, Fingerprint, Timer, X } from 'lucide-react';
import { useContext, useMemo, useState } from 'react';

import { connectionsOptions } from '../../kit/connections/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import type { LiveMetricView } from './metrics-live';
import { OperationalMetrics } from './operational-metrics';
import { operationalMetricsOptions } from './operational-metrics-data';

const api = createWebApiClient();
const metrics: OperationalMetricRequest['metrics'] = [
  'resolution.detected',
  'resolution.completed',
  'resolution.completion_time',
  'resolution.eligible',
  'resolution.autonomous',
  'resolution.human',
  'resolution.pending',
  'resolution.unknown',
  'resolution.unknown_eligibility',
  'resolution.recurrent',
  'resolution.incorrect_actions',
  'resolution.unresolved_age',
];

/**
 * Reads server release availability from the same authorized registry used for report queries.
 * Undefined until the registry has been read, so a page doesn't read the wrong cohort first.
 */
export function useResolutionReporting(organizationId: string) {
  const registry = useQuery({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'metric-registry'],
    queryFn: ({ signal }) =>
      api.metrics.operationalDefinitions(
        { params: { organizationId } },
        { signal },
      ),
  });
  if (registry.isPending) return undefined;

  return (
    registry.data?.some(
      (definition) => definition.id === 'resolution.completed',
    ) ?? false
  );
}

/**
 * The report's part of the Insights address: its interval, cohort filters and workflow version.
 * The page that shows the report owns the address and passes this part through.
 */
export type ReportSearch = {
  reportArtifact?: string | undefined;
  reportVersion?: string | undefined;
  reportWindow?: '7d' | '30d' | 'custom' | undefined;
  reportStart?: string | undefined;
  reportEnd?: string | undefined;
  reportClass?: string | undefined;
  reportSource?: string | undefined;
  reportEnv?: NonNullable<OperationalMetricRequest['scope']>['environment'];
};

type ReportingRequest = Omit<OperationalMetricRequest, 'scope'> & {
  scope: NonNullable<OperationalMetricRequest['scope']> & {
    start: string;
    end: string;
  };
};

/** Builds a pinned half-open reporting scope; the same request powers counts and every drilldown. */
export function resolutionReportingRequest(
  search: ReportSearch,
  end: string,
): ReportingRequest {
  const endAt = search.reportEnd ?? end;
  const start =
    search.reportStart ??
    new Date(
      Date.parse(endAt) - (search.reportWindow === '7d' ? 7 : 30) * 86400000,
    ).toISOString();

  return {
    definitionVersion: 2,
    metrics,
    scope: {
      start,
      end: endAt,
      environment: search.reportEnv ?? 'live',
      ...(search.reportClass ? { issueClass: search.reportClass } : {}),
      ...(search.reportSource ? { connectionId: search.reportSource } : {}),
      ...(search.reportArtifact && search.reportVersion
        ? {
            artifactId: search.reportArtifact,
            artifactVersion: search.reportVersion,
          }
        : {}),
    },
  };
}

const count = (response: OperationalMetricResponse | undefined, id: string) =>
  response?.metrics.find(
    (metric) => metric.definition.id === `resolution.${id}`,
  );

/**
 * The report's request for the address. A rolling period ends when the report was opened, so
 * live refreshes recount the same cohort instead of moving its boundaries. Opening the report
 * again (`active` turning true) or `renew` moves the end to now.
 */
export function useResolutionReportRequest(
  search: ReportSearch,
  active: boolean,
) {
  const [anchor, setAnchor] = useState(() => new Date().toISOString());
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setAnchor(new Date().toISOString());
  }
  const {
    reportStart,
    reportEnd,
    reportWindow,
    reportClass,
    reportSource,
    reportEnv,
    reportArtifact,
    reportVersion,
  } = search;

  const request = useMemo(
    () =>
      resolutionReportingRequest(
        {
          reportStart,
          reportEnd,
          reportWindow,
          reportClass,
          reportSource,
          reportEnv,
          reportArtifact,
          reportVersion,
        },
        anchor,
      ),
    [
      reportStart,
      reportEnd,
      reportWindow,
      reportClass,
      reportSource,
      reportEnv,
      reportArtifact,
      reportVersion,
      anchor,
    ],
  );

  return {
    request,
    renew: () => {
      if (!reportEnd) setAnchor(new Date().toISOString());
    },
  };
}

/**
 * Reports persisted incident cohorts, with honest unknown states and exact evidence drilldowns.
 * `live` is the page's live read of `request`, so the page states its delivery and refreshes it.
 */
export function ResolutionReport({
  organizationId,
  search,
  onSearch,
  request,
  live,
}: {
  organizationId: string;
  search: ReportSearch;
  onSearch: (patch: Partial<ReportSearch>) => void;
  request: ReportingRequest;
  live: LiveMetricView<OperationalMetricResponse>;
}) {
  const previousRequest = useMemo(() => {
    const start = Date.parse(request.scope.start);
    const duration = Date.parse(request.scope.end) - start;

    return {
      ...request,
      metrics: [
        'resolution.detected',
      ] satisfies OperationalMetricRequest['metrics'],
      limit: 1,
      scope: {
        ...request.scope,
        start: new Date(start - duration).toISOString(),
        end: new Date(start).toISOString(),
      },
    };
  }, [request]);
  const previous = useQuery(
    operationalMetricsOptions(organizationId, previousRequest),
  );
  const connections = useQuery(connectionsOptions(organizationId));

  return (
    <ResolutionReportView
      organizationId={organizationId}
      search={search}
      onSearch={onSearch}
      request={request}
      live={{ resolution: live }}
      previousData={
        !previous.isError && !previous.isPaused ? previous.data : undefined
      }
      connections={connections.data ?? []}
    />
  );
}

const environmentLabels = {
  live: m.overview_outcomes_env_live,
  pilot: m.overview_outcomes_env_pilot,
  synthetic: m.overview_outcomes_env_synthetic,
  shadow: m.overview_outcomes_env_shadow,
  unknown: m.overview_outcomes_env_unknown,
};

/**
 * Chooses the reporting interval, connection, environment and issue class. Every choice is in
 * the address, so a report can be shared and reopened with the same cohort. A connection that
 * no longer exists stays selectable under its ID so its history remains reachable.
 */
export function ResolutionReportFilters({
  organizationId,
  search,
  onSearch,
}: {
  organizationId: string;
  search: ReportSearch;
  onSearch: (patch: Partial<ReportSearch>) => void;
}) {
  const connections = useQuery(connectionsOptions(organizationId)).data ?? [];
  const environment = search.reportEnv ?? 'live';

  return (
    <>
      <Select
        className="resolution-report-filter"
        aria-label={m.overview_report_period()}
        value={search.reportWindow ?? '30d'}
        options={[
          { value: '7d', label: m.overview_report_7d() },
          { value: '30d', label: m.overview_report_30d() },
          { value: 'custom', label: m.overview_report_custom() },
        ]}
        onValueChange={(value) => {
          if (value)
            onSearch({
              reportWindow: value,
              reportStart: undefined,
              reportEnd: undefined,
            });
        }}
      />
      <Select
        className="resolution-report-filter"
        aria-label={m.overview_report_source()}
        value={search.reportSource ?? 'all'}
        options={[
          { value: 'all', label: m.overview_report_all_sources() },
          ...connections.map((connection) => ({
            value: connection.id,
            label: connection.label,
          })),
          ...(search.reportSource &&
          !connections.some(
            (connection) => connection.id === search.reportSource,
          )
            ? [
                {
                  value: search.reportSource,
                  label: m.overview_report_retired_source({
                    id: search.reportSource,
                  }),
                },
              ]
            : []),
        ]}
        onValueChange={(value) =>
          onSearch({
            reportSource: value === 'all' ? undefined : (value ?? undefined),
          })
        }
      />
      <Select
        className="resolution-report-filter"
        aria-label={m.overview_outcomes_env_label()}
        value={environment}
        options={(
          ['live', 'pilot', 'synthetic', 'shadow', 'unknown'] as const
        ).map((value) => ({ value, label: environmentLabels[value]() }))}
        onValueChange={(value) => {
          if (value) onSearch({ reportEnv: value });
        }}
      />
      <Select
        className="resolution-report-filter"
        aria-label={m.overview_report_class()}
        value={search.reportClass ?? 'all'}
        options={[
          { value: 'all', label: m.overview_report_all_classes() },
          ...caseClasses.map((value) => ({
            value,
            label: issueKind({ class: value }).label,
          })),
        ]}
        onValueChange={(value) =>
          onSearch({
            reportClass: value === 'all' ? undefined : (value ?? undefined),
          })
        }
      />
      {environment !== 'live' ? (
        <Badge tone="warning">{m.overview_outcomes_excluded()}</Badge>
      ) : null}
    </>
  );
}

const durationBuckets = ['under_5m', '5m_1h', '1h_1d', 'over_1d'] as const;

const durationLabels = {
  under_5m: m.overview_report_under_5m,
  '5m_1h': m.overview_report_5m_1h,
  '1h_1d': m.overview_report_1h_1d,
  over_1d: m.overview_report_over_1d,
} satisfies Record<(typeof durationBuckets)[number], () => string>;

type CohortRow = {
  key: string;
  label: string;
  count: number;
  open: () => void;
};

/** Presents recorded reporting facts and accurate unavailable states without supplying sample values. */
export function ResolutionReportView({
  organizationId,
  search,
  onSearch,
  request,
  live,
  previousData,
  connections,
}: {
  organizationId: string;
  search: ReportSearch;
  onSearch: (patch: Partial<ReportSearch>) => void;
  request: ReportingRequest;
  live: { resolution: LiveMetricView<OperationalMetricResponse> };
  previousData: OperationalMetricResponse | undefined;
  connections: Pick<InstalledConnection, 'id' | 'label'>[];
}) {
  const timezone = useContext(WorkspaceTimezone);
  const [dailyView, setDailyView] = useState<'chart' | 'table'>('chart');
  const data =
    live.resolution.isError ||
    live.resolution.isPaused ||
    live.resolution.connection === 'denied' ||
    live.resolution.connection === 'offline'
      ? undefined
      : live.resolution.data;
  const eligible = count(data, 'eligible');
  const autonomous = count(data, 'autonomous');
  const denominator = eligible?.total,
    numerator = autonomous?.total;
  const rate =
    denominator !== null &&
    denominator !== undefined &&
    denominator > 0 &&
    numerator !== null &&
    numerator !== undefined
      ? { numerator, denominator, value: numerator / denominator }
      : null;
  const recurrence = count(data, 'recurrent');
  const completion = count(data, 'completed');
  const duration = count(data, 'completion_time');
  const detected = count(data, 'detected');
  const days = [
    ...new Set(
      [...(detected?.breakdown ?? []), ...(completion?.breakdown ?? [])]
        .filter((row) => row.reason.startsWith('day:'))
        .map((row) => row.reason.slice(4)),
    ),
  ].sort();
  const dayCount = (
    metric: OperationalMetricResponse['metrics'][number] | undefined,
    day: string,
  ) => metric?.breakdown.find((row) => row.reason === `day:${day}`)?.count ?? 0;
  const previousDetected = count(previousData, 'detected');
  const currentCount = detected?.total,
    priorCount = previousDetected?.total;
  const comparison =
    (detected?.observedCount ?? 0) >= 5 &&
    (previousDetected?.observedCount ?? 0) >= 5 &&
    currentCount !== null &&
    currentCount !== undefined &&
    priorCount !== null &&
    priorCount !== undefined
      ? {
          current: currentCount,
          previous: priorCount,
          difference: currentCount - priorCount,
        }
      : null;
  const metricGroups = [
    {
      id: 'report-volume',
      title: m.overview_report_volume,
      subtitle: m.overview_report_volume_help,
      icon: CheckCheck,
    },
    {
      id: 'report-cohort',
      title: m.overview_report_cohort,
      subtitle: m.overview_report_cohort_help,
      icon: Fingerprint,
    },
    {
      id: 'report-time',
      title: m.overview_report_time,
      subtitle: m.overview_report_time_help,
      icon: Timer,
    },
  ].map((group) => ({
    ...group,
    metrics:
      group.id === 'report-volume'
        ? ['resolution.detected', 'resolution.completed']
        : group.id === 'report-time'
          ? ['resolution.completion_time', 'resolution.unresolved_age']
          : metrics.filter(
              (id) =>
                ![
                  'resolution.detected',
                  'resolution.completed',
                  'resolution.completion_time',
                  'resolution.unresolved_age',
                ].includes(id),
            ),
  }));

  const selectDay = (day: string) =>
    onSearch({
      reportWindow: 'custom',
      reportStart: new Date(
        Math.max(
          Date.parse(`${day}T00:00:00Z`),
          Date.parse(request.scope.start),
        ),
      ).toISOString(),
      reportEnd: new Date(
        Math.min(
          Date.parse(`${day}T00:00:00Z`) + 86400000,
          Date.parse(request.scope.end),
        ),
      ).toISOString(),
    });

  const connectionLabel = (id: string) =>
    connections.find((connection) => connection.id === id)?.label ??
    m.overview_report_retired_source({ id });
  const systems: CohortRow[] =
    completion?.breakdown
      .filter((row) => row.reason.startsWith('connection:'))
      .map((row) => {
        const id = row.reason.slice(11);

        return {
          key: row.reason,
          label: connectionLabel(id),
          count: row.count,
          open: () => onSearch({ reportSource: id }),
        };
      }) ?? [];
  const versions: CohortRow[] =
    completion?.breakdown.flatMap((row) => {
      if (!row.reason.startsWith('version:')) return [];
      const version: unknown = JSON.parse(row.reason.slice(8));
      if (
        !Array.isArray(version) ||
        version.length !== 2 ||
        typeof version[0] !== 'string' ||
        typeof version[1] !== 'string'
      )
        return [];
      const [id, revision] = version;

      return [
        {
          key: row.reason,
          label: `${id} · ${revision}`,
          count: row.count,
          open: () => onSearch({ reportArtifact: id, reportVersion: revision }),
        },
      ];
    }) ?? [];
  const classes: CohortRow[] =
    recurrence?.breakdown
      .filter((entry) => entry.reason.startsWith('class:'))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .map((entry) => ({
        key: entry.reason,
        label: issueKind({ class: entry.reason.slice(6) }).label,
        count: entry.count,
        open: () => onSearch({ reportClass: entry.reason.slice(6) }),
      })) ?? [];
  const cohortTable = (
    rows: CohortRow[],
    caption: string,
    header: string,
    countHeader: string,
  ) => (
    <DataTable
      caption={caption}
      columns={[
        { key: 'label', header, cell: (row) => row.label },
        {
          key: 'count',
          header: countHeader,
          numeric: true,
          cell: (row) => formatNumber(row.count),
        },
        {
          key: 'open',
          header: m.overview_report_evidence(),
          cell: (row) => (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${m.overview_report_open_cohort()}: ${row.label}`}
              onClick={row.open}
            >
              {m.overview_report_open_cohort()}
            </Button>
          ),
        },
      ]}
      rows={rows}
      rowKey={(row) => row.key}
      density="compact"
      variant="plain"
    />
  );

  return (
    <section
      className="resolution-report"
      aria-label={m.overview_report_section()}
    >
      {search.reportWindow === 'custom' ? (
        <CustomInterval
          key={`${search.reportStart}:${search.reportEnd}`}
          start={search.reportStart ?? request.scope.start}
          end={search.reportEnd ?? request.scope.end}
          apply={onSearch}
        />
      ) : null}
      <p className="resolution-report-interval">
        <span>
          {m.overview_report_interval({ timezone })}{' '}
          <WorkspaceDate value={request.scope.start} /> –{' '}
          <WorkspaceDate value={request.scope.end} />
        </span>
        {data ? (
          <span>
            {m.overview_report_asof()} <WorkspaceDate value={data.asOf} />
          </span>
        ) : null}
        {search.reportArtifact ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onSearch({ reportArtifact: undefined, reportVersion: undefined })
            }
          >
            {m.overview_report_clear_version()}: {search.reportArtifact} ·{' '}
            {search.reportVersion}
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </p>
      <dl className="resolution-summary">
        <Card as="div" className="resolution-summary-tile">
          <dt>{m.overview_report_rate_title()}</dt>
          <dd>
            <strong>
              {rate ? formatPercent(rate.value) : m.common_empty_value()}
            </strong>
            <span>
              {rate
                ? m.overview_report_rate_caption({
                    numerator: formatNumber(rate.numerator),
                    denominator: formatNumber(rate.denominator),
                  })
                : m.overview_report_rate_unknown()}
            </span>
          </dd>
        </Card>
        <Card as="div" className="resolution-summary-tile">
          <dt>{m.overview_report_change_title()}</dt>
          <dd>
            <strong>
              {comparison
                ? formatNumber(comparison.difference, {
                    signDisplay: 'exceptZero',
                  })
                : m.common_empty_value()}
            </strong>
            <span>
              {comparison
                ? m.overview_report_comparison({
                    current: formatNumber(comparison.current),
                    previous: formatNumber(comparison.previous),
                    difference: formatNumber(comparison.difference),
                  })
                : m.overview_report_comparison_unknown()}
            </span>
          </dd>
        </Card>
        <Card as="div" className="resolution-summary-tile">
          <dt>{m.overview_report_sample_title()}</dt>
          <dd>
            <strong>{formatNumber(duration?.observedCount ?? 0)}</strong>
            <span>
              {duration && duration.observedCount < 5
                ? m.overview_report_low_sample({
                    count: duration.observedCount,
                  })
                : m.overview_report_sample({
                    count: duration?.observedCount ?? 0,
                  })}
            </span>
          </dd>
        </Card>
      </dl>
      <OperationalMetrics
        key={JSON.stringify(request)}
        organizationId={organizationId}
        live={live.resolution}
        initialRequest={request}
        metricGroups={metricGroups}
        heading={m.overview_report_title()}
        description={m.overview_report_description()}
        embedded
      />
      <div className="resolution-report-grid">
        <Card as="section" className="resolution-report-card" data-wide="">
          <header>
            <h3>{m.overview_report_daily()}</h3>
            {days.length ? (
              <Tabs
                value={dailyView}
                onValueChange={(next) =>
                  setDailyView(next === 'table' ? 'table' : 'chart')
                }
              >
                <TabsList
                  aria-label={m.insights_card_view_label({
                    chart: m.overview_report_daily(),
                  })}
                  activateOnFocus={false}
                >
                  <TabsTrigger value="chart">
                    {m.insights_card_view_chart()}
                  </TabsTrigger>
                  <TabsTrigger value="table">
                    {m.insights_card_view_table()}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null}
          </header>
          {!days.length ? (
            <p className="resolution-report-empty">
              {m.overview_report_no_trend()}
            </p>
          ) : dailyView === 'chart' ? (
            <div className="resolution-report-trends">
              {[
                {
                  metric: detected,
                  label: m.overview_report_detected(),
                  color: 'chart-1' as const,
                },
                {
                  metric: completion,
                  label: m.overview_report_verified(),
                  color: 'chart-2' as const,
                },
              ].map(({ metric, label, color }) => (
                <div key={label}>
                  <h4>{label}</h4>
                  <BarChart
                    label={`${m.overview_report_daily()} · ${label}`}
                    orientation="vertical"
                    integerTicks
                    series={[{ id: 'count', label, color }]}
                    categories={days.map((day) => ({
                      key: day,
                      label: formatCalendarDate(day),
                      values: { count: dayCount(metric, day) },
                    }))}
                    unit={formatNumber}
                    onSelect={({ category }) => selectDay(category)}
                  />
                </div>
              ))}
            </div>
          ) : (
            <DataTable
              caption={m.overview_report_daily()}
              columns={[
                {
                  key: 'day',
                  header: m.overview_report_day(),
                  cell: (day) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${m.overview_report_open_cohort()}: ${formatCalendarDate(day)}`}
                      onClick={() => selectDay(day)}
                    >
                      {formatCalendarDate(day)}
                    </Button>
                  ),
                },
                {
                  key: 'detected',
                  header: m.overview_report_detected(),
                  numeric: true,
                  cell: (day) => formatNumber(dayCount(detected, day)),
                },
                {
                  key: 'verified',
                  header: m.overview_report_verified(),
                  numeric: true,
                  cell: (day) => formatNumber(dayCount(completion, day)),
                },
              ]}
              rows={days}
              rowKey={(day) => day}
              density="compact"
              variant="plain"
            />
          )}
        </Card>
        <Card as="section" className="resolution-report-card">
          <header>
            <h3>{m.overview_report_distribution()}</h3>
          </header>
          {duration ? (
            <BarChart
              label={m.overview_report_distribution()}
              orientation="horizontal"
              integerTicks
              series={[
                {
                  id: 'count',
                  label: m.overview_report_verified(),
                  color: 'chart-2',
                },
              ]}
              categories={durationBuckets.map((bucket) => ({
                key: bucket,
                label: durationLabels[bucket](),
                values: {
                  count:
                    duration.breakdown.find(
                      (row) => row.reason === `duration:${bucket}`,
                    )?.count ?? 0,
                },
              }))}
              unit={formatNumber}
            />
          ) : (
            <p className="resolution-report-empty">{m.common_unknown()}</p>
          )}
        </Card>
        <Card as="section" className="resolution-report-card">
          <header>
            <h3>{m.overview_report_recurring()}</h3>
          </header>
          {!data ? (
            <p className="resolution-report-empty">
              {m.overview_report_unavailable()}
            </p>
          ) : classes.length ? (
            cohortTable(
              classes,
              m.overview_report_recurring(),
              m.overview_report_class(),
              m.overview_report_count(),
            )
          ) : (
            <p className="resolution-report-empty">
              {m.overview_report_no_recurrence()}
            </p>
          )}
        </Card>
        {systems.length ? (
          <Card as="section" className="resolution-report-card">
            <header>
              <h3>{m.overview_report_systems()}</h3>
            </header>
            {cohortTable(
              systems,
              m.overview_report_systems(),
              m.overview_report_source(),
              m.overview_report_verified(),
            )}
          </Card>
        ) : null}
        {versions.length ? (
          <Card as="section" className="resolution-report-card">
            <header>
              <h3>{m.overview_report_versions()}</h3>
            </header>
            {cohortTable(
              versions,
              m.overview_report_versions(),
              m.overview_report_version(),
              m.overview_report_verified(),
            )}
            <p className="resolution-report-note">
              {m.overview_report_versions_help()}
            </p>
          </Card>
        ) : null}
      </div>
      <p className="resolution-report-note">
        {m.overview_report_through_unknown()}
      </p>
    </section>
  );
}

function CustomInterval({
  start,
  end,
  apply,
}: {
  start: string;
  end: string;
  apply: (patch: Partial<ReportSearch>) => void;
}) {
  const [draftStart, setStart] = useState(start);
  const [draftEnd, setEnd] = useState(end);
  const [invalid, setInvalid] = useState(false);

  function submit() {
    const from = Date.parse(draftStart),
      before = Date.parse(draftEnd);
    const explicit = /(?:Z|[+-]\d{2}:\d{2})$/;
    if (
      !explicit.test(draftStart) ||
      !explicit.test(draftEnd) ||
      !Number.isFinite(from) ||
      !Number.isFinite(before) ||
      before <= from ||
      before > Date.now() ||
      before - from > 366 * 86400000
    ) {
      setInvalid(true);

      return;
    }
    setInvalid(false);
    apply({
      reportStart: new Date(from).toISOString(),
      reportEnd: new Date(before).toISOString(),
      reportWindow: 'custom',
    });
  }

  return (
    <form
      className="resolution-report-custom"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label>
        {m.overview_report_start()}
        <Input
          value={draftStart}
          onChange={(event) => setStart(event.target.value)}
          placeholder="2026-10-01T00:00:00Z"
          aria-invalid={invalid}
        />
      </label>
      <label>
        {m.overview_report_end()}
        <Input
          value={draftEnd}
          onChange={(event) => setEnd(event.target.value)}
          placeholder="2026-10-13T00:00:00Z"
          aria-invalid={invalid}
        />
      </label>
      <Button type="submit" variant="outline">
        {m.overview_report_apply()}
      </Button>
      {invalid ? <p role="alert">{m.overview_report_invalid()}</p> : null}
    </form>
  );
}
