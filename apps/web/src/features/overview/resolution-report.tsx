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
import { BarChart } from '@luma/ui/components/primitives/bar-chart';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import {
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, Fingerprint, Timer } from 'lucide-react';
import { useContext, useMemo, useState } from 'react';

import { connectionsOptions } from '../../kit/connections/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import type { InsightsSearch } from '../insights/data';
import { type LiveMetricView, useLiveMetricSummary } from './metrics-live';
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

/** Reads server release availability from the same authorized registry used for report queries. */
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

  return (
    registry.data?.some(
      (definition) => definition.id === 'resolution.completed',
    ) ?? false
  );
}

type ReportingRequest = Omit<OperationalMetricRequest, 'scope'> & {
  scope: NonNullable<OperationalMetricRequest['scope']> & {
    start: string;
    end: string;
  };
};

/** Builds a pinned half-open reporting scope; the same request powers counts and every drilldown. */
export function resolutionReportingRequest(
  search: InsightsSearch,
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

/** Reports persisted incident cohorts, with honest unknown states and exact evidence drilldowns. */
export function ResolutionReport({
  organizationId,
  search,
  onSearch,
}: {
  organizationId: string;
  search: InsightsSearch;
  onSearch: (patch: Partial<InsightsSearch>) => void;
}) {
  const [anchor] = useState(() => new Date().toISOString());
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
  const live = useLiveMetricSummary(organizationId, { resolution: request });
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
      live={live}
      previousData={
        !previous.isError && !previous.isPaused ? previous.data : undefined
      }
      connections={connections.data ?? []}
    />
  );
}

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
  search: InsightsSearch;
  onSearch: (patch: Partial<InsightsSearch>) => void;
  request: ReportingRequest;
  live: { resolution: LiveMetricView<OperationalMetricResponse> };
  previousData: OperationalMetricResponse | undefined;
  connections: Pick<InstalledConnection, 'id' | 'label'>[];
}) {
  const timezone = useContext(WorkspaceTimezone);
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
  const classes =
    recurrence?.breakdown
      .filter((entry) => entry.reason.startsWith('class:'))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)) ??
    [];
  const completion = count(data, 'completed');
  const duration = count(data, 'completion_time');
  const days = [
    ...new Set(
      [
        ...(count(data, 'detected')?.breakdown ?? []),
        ...(completion?.breakdown ?? []),
      ]
        .filter((row) => row.reason.startsWith('day:'))
        .map((row) => row.reason.slice(4)),
    ),
  ].sort();
  const versions =
    completion?.breakdown.filter((row) => row.reason.startsWith('version:')) ??
    [];
  const systems =
    completion?.breakdown.filter((row) =>
      row.reason.startsWith('connection:'),
    ) ?? [];
  const detected = count(data, 'detected');
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

  return (
    <section
      className="resolution-report"
      aria-label={m.overview_report_section()}
    >
      <div className="resolution-report-controls">
        <Select
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
          aria-label={m.overview_outcomes_env_label()}
          value={search.reportEnv ?? 'live'}
          options={(
            ['live', 'pilot', 'synthetic', 'shadow', 'unknown'] as const
          ).map((value) => ({
            value,
            label: {
              live: m.overview_outcomes_env_live,
              pilot: m.overview_outcomes_env_pilot,
              synthetic: m.overview_outcomes_env_synthetic,
              shadow: m.overview_outcomes_env_shadow,
              unknown: m.overview_outcomes_env_unknown,
            }[value](),
          }))}
          onValueChange={(value) => {
            if (value) onSearch({ reportEnv: value });
          }}
        />
        <Select
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
      </div>
      {search.reportWindow === 'custom' ? (
        <CustomInterval
          key={`${search.reportStart}:${search.reportEnd}`}
          start={search.reportStart ?? request.scope.start}
          end={search.reportEnd ?? request.scope.end}
          apply={onSearch}
        />
      ) : null}
      <p>
        {m.overview_report_interval({ timezone })}{' '}
        <WorkspaceDate value={request.scope.start} /> –{' '}
        <WorkspaceDate value={request.scope.end} />
      </p>
      <p>
        {data ? (
          <>
            {m.overview_report_asof()} <WorkspaceDate value={data.asOf} />.{' '}
          </>
        ) : null}
        {m.overview_report_through_unknown()}
      </p>
      <p>
        {rate
          ? m.overview_report_rate({
              rate: formatPercent(rate.value),
              numerator: formatNumber(rate.numerator),
              denominator: formatNumber(rate.denominator),
            })
          : m.overview_report_rate_unknown()}
      </p>
      <p>
        {comparison
          ? m.overview_report_comparison({
              current: formatNumber(comparison.current),
              previous: formatNumber(comparison.previous),
              difference: formatNumber(comparison.difference),
            })
          : m.overview_report_comparison_unknown()}
      </p>
      {duration && duration.observedCount < 5 ? (
        <p>{m.overview_report_low_sample({ count: duration.observedCount })}</p>
      ) : null}
      {search.reportClass ? (
        <Button
          variant="ghost"
          onClick={() => onSearch({ reportClass: undefined })}
        >
          {m.overview_report_clear_class()}
        </Button>
      ) : null}
      <OperationalMetrics
        key={JSON.stringify(request)}
        organizationId={organizationId}
        live={live.resolution}
        initialRequest={request}
        metricGroups={metricGroups}
        heading={m.overview_report_title()}
        eyebrow={m.overview_report_eyebrow()}
        description={m.overview_report_description()}
      />
      <h3>{m.overview_report_daily()}</h3>
      {days.length ? (
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
                  values: {
                    count:
                      metric?.breakdown.find(
                        (row) => row.reason === `day:${day}`,
                      )?.count ?? 0,
                  },
                }))}
                unit={formatNumber}
                onSelect={({ category }) => selectDay(category)}
              />
            </div>
          ))}
        </div>
      ) : null}
      {days.length ? (
        <table>
          <thead>
            <tr>
              <th scope="col">{m.overview_report_day()}</th>
              <th scope="col">{m.overview_report_detected()}</th>
              <th scope="col">{m.overview_report_verified()}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day}>
                <th scope="row">
                  <Button
                    variant="ghost"
                    aria-label={`${m.overview_report_open_cohort()}: ${formatCalendarDate(day)}`}
                    onClick={() => selectDay(day)}
                  >
                    {formatCalendarDate(day)}
                  </Button>
                </th>
                <td>
                  {formatNumber(
                    detected?.breakdown.find(
                      (row) => row.reason === `day:${day}`,
                    )?.count ?? 0,
                  )}
                </td>
                <td>
                  {formatNumber(
                    completion?.breakdown.find(
                      (row) => row.reason === `day:${day}`,
                    )?.count ?? 0,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>{m.overview_report_no_trend()}</p>
      )}
      <h3>{m.overview_report_distribution()}</h3>
      <p>{m.overview_report_sample({ count: duration?.observedCount ?? 0 })}</p>
      <table>
        <thead>
          <tr>
            <th scope="col">{m.overview_report_duration()}</th>
            <th scope="col">{m.overview_report_verified()}</th>
          </tr>
        </thead>
        <tbody>
          {(['under_5m', '5m_1h', '1h_1d', 'over_1d'] as const).map(
            (bucket) => (
              <tr key={bucket}>
                <th scope="row">
                  {{
                    under_5m: m.overview_report_under_5m,
                    '5m_1h': m.overview_report_5m_1h,
                    '1h_1d': m.overview_report_1h_1d,
                    over_1d: m.overview_report_over_1d,
                  }[bucket]()}
                </th>
                <td>
                  {duration
                    ? formatNumber(
                        duration.breakdown.find(
                          (row) => row.reason === `duration:${bucket}`,
                        )?.count ?? 0,
                      )
                    : m.common_unknown()}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {systems.length ? (
        <>
          <h3>{m.overview_report_systems()}</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">{m.overview_report_source()}</th>
                <th scope="col">{m.overview_report_verified()}</th>
                <th scope="col">{m.overview_report_evidence()}</th>
              </tr>
            </thead>
            <tbody>
              {systems.map((row) => (
                <tr key={row.reason}>
                  <th scope="row">
                    {connections.find(
                      (connection) => connection.id === row.reason.slice(11),
                    )?.label ??
                      m.overview_report_retired_source({
                        id: row.reason.slice(11),
                      })}
                  </th>
                  <td>{formatNumber(row.count)}</td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        onSearch({ reportSource: row.reason.slice(11) })
                      }
                    >
                      {m.overview_report_open_cohort()}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {versions.length ? (
        <>
          <h3>{m.overview_report_versions()}</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">{m.overview_report_version()}</th>
                <th scope="col">{m.overview_report_verified()}</th>
                <th scope="col">{m.overview_report_evidence()}</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((row) => {
                const version: unknown = JSON.parse(row.reason.slice(8));
                if (
                  !Array.isArray(version) ||
                  version.length !== 2 ||
                  typeof version[0] !== 'string' ||
                  typeof version[1] !== 'string'
                )
                  return null;
                const [id, revision] = version;

                return (
                  <tr key={row.reason}>
                    <th scope="row">
                      {id} · {revision}
                    </th>
                    <td>{formatNumber(row.count)}</td>
                    <td>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          onSearch({
                            reportArtifact: id,
                            reportVersion: revision,
                          })
                        }
                      >
                        {m.overview_report_open_cohort()}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p>{m.overview_report_versions_help()}</p>
        </>
      ) : null}
      {search.reportArtifact ? (
        <Button
          variant="ghost"
          onClick={() =>
            onSearch({ reportArtifact: undefined, reportVersion: undefined })
          }
        >
          {m.overview_report_clear_version()}
        </Button>
      ) : null}
      <h3>{m.overview_report_recurring()}</h3>
      {data ? (
        classes.length ? (
          <table>
            <thead>
              <tr>
                <th scope="col">{m.overview_report_class()}</th>
                <th scope="col">{m.overview_report_count()}</th>
                <th scope="col">{m.overview_report_evidence()}</th>
              </tr>
            </thead>
            <tbody>
              {classes.map((entry) => (
                <tr key={entry.reason}>
                  <th scope="row">
                    {issueKind({ class: entry.reason.slice(6) }).label}
                  </th>
                  <td>{formatNumber(entry.count)}</td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        onSearch({ reportClass: entry.reason.slice(6) })
                      }
                    >
                      {m.overview_report_open_cohort()}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>{m.overview_report_no_recurrence()}</p>
        )
      ) : (
        <p>{m.overview_report_unavailable()}</p>
      )}
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
  apply: (patch: Partial<InsightsSearch>) => void;
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
