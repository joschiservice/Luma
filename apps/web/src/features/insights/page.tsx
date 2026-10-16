import './insights.css';

import type { OperationalMetricResponse } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { CollectionViews } from '@luma/ui/components/primitives/collection-toolbar';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { Select } from '@luma/ui/components/primitives/select';
import { StateDot } from '@luma/ui/components/primitives/state';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@luma/ui/components/primitives/toggle-group';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { Activity, ChartColumn, CircleCheckBig } from 'lucide-react';
import { type ReactNode, useId, useMemo, useRef } from 'react';

import { connectionsOptions } from '../../kit/connections/data';
import { PurchasingOutcomePanel } from '../../shared/procurement/purchasing-outcomes';
import { metricSummaryKey } from '../overview/metric-summary-data';
import {
  type LiveConnection,
  type MetricInspector,
  useLiveMetricSummary,
} from '../overview/metrics-live';
import {
  operationalMetricGroups,
  OperationalMetrics,
} from '../overview/operational-metrics';
import { operationalMetricRequest } from '../overview/operational-metrics-data';
import { orderMetricRequest, OrderMetrics } from '../overview/order-metrics';
import {
  OutcomeFilters,
  resolutionMetricRequest,
  ResolutionOutcomes,
} from '../overview/resolution-outcomes';
import {
  ResolutionReport,
  ResolutionReportFilters,
  useResolutionReporting,
  useResolutionReportRequest,
} from '../overview/resolution-report';
import { AttentionSummary } from './attention-summary';
import { InsightCharts } from './charts';
import {
  currentStateCharts,
  insightRanges,
  insightsKey,
  type InsightsSearch,
  insightsView,
  type InsightView,
  nextInsightsSearch,
  trendCharts,
} from './data';

const rangeShortLabels = {
  '7d': m.insights_range_7d_short,
  '30d': m.insights_range_30d_short,
  '13w': m.insights_range_13w_short,
} satisfies Record<(typeof insightRanges)[number], () => string>;

// Connections are summarized in the toolbar, where their health qualifies every view.
const nowGroups = operationalMetricGroups.filter(
  (group) => group.id !== 'connections',
);

/**
 * Answers three questions in three views: what is waiting now, how orders and issues develop
 * over time, and what Luma's handling achieved. One toolbar holds the view, the filters that
 * view uses, the health of the connections behind every number, the live status and Refresh.
 * Every number opens its records. The metric sections share one live summary read of the
 * metrics on screen; the toolbar's status and Refresh describe the reads of the current view.
 */
export function InsightsPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/insights',
  });
  const search = useSearch({ from: '/app/$organizationId/insights' });
  const navigate = useNavigate({ from: '/app/$organizationId/insights' });
  const location = useLocation();
  const client = useQueryClient();
  const operationalInspector = useRef<MetricInspector>(null);
  const ordersInspector = useRef<MetricInspector>(null);
  const view = insightsView(search);
  const reporting = useResolutionReporting(organizationId);
  const report = useResolutionReportRequest(search, view === 'outcomes');
  const environment = search.outcomeEnv ?? 'live';
  const window = search.outcomeWindow ?? '7d';
  const outcomes = useMemo(
    () => resolutionMetricRequest(environment, window),
    [environment, window],
  );
  // Each view reads only the metrics it shows. Connection health, in the toolbar, reads the
  // operational summary on every view.
  const live = useLiveMetricSummary(organizationId, {
    operational: operationalMetricRequest,
    resolution:
      view !== 'outcomes' || reporting === undefined
        ? undefined
        : reporting
          ? report.request
          : outcomes,
    orders: view === 'now' ? orderMetricRequest : undefined,
  });
  const scopeKey = (area: string) => [
    'private',
    'organization',
    organizationId,
    area,
  ];
  const chartsFetching =
    useIsFetching({ queryKey: insightsKey(organizationId) }) > 0;
  const outcomesFetching =
    useIsFetching({ queryKey: scopeKey('resolution-metrics') }) +
      useIsFetching({ queryKey: scopeKey('purchasing-outcomes') }) >
    0;
  // The status and Refresh describe the reads of the view on screen.
  const read = view === 'outcomes' ? live.resolution : live.operational;
  const refreshing =
    read.isFetching ||
    (view === 'outcomes' ? outcomesFetching : chartsFetching);
  const onSearch = (patch: Partial<InsightsSearch>) =>
    void navigate({
      search: (previous) => nextInsightsSearch(previous, patch),
      resetScroll: false,
    });
  // A new scope closes the records of the old one; they would no longer match the chart.
  const scoped = (patch: Partial<InsightsSearch>) =>
    onSearch({
      ...patch,
      chart: undefined,
      point: undefined,
      series: undefined,
    });
  const refresh = () => {
    if (view === 'outcomes') report.renew();
    for (const queryKey of [
      insightsKey(organizationId),
      metricSummaryKey(organizationId),
      scopeKey('resolution-metrics'),
      scopeKey('purchasing-outcomes'),
    ])
      void client.invalidateQueries({ queryKey });
  };
  const views = [
    {
      value: 'now' as const,
      label: m.insights_view_now(),
      description: m.insights_view_now_description(),
      icon: <Activity aria-hidden="true" />,
    },
    {
      value: 'trends' as const,
      label: m.insights_view_trends(),
      description: m.insights_view_trends_description(),
      icon: <ChartColumn aria-hidden="true" />,
    },
    {
      value: 'outcomes' as const,
      label: m.insights_view_outcomes(),
      description: m.insights_view_outcomes_description(),
      icon: <CircleCheckBig aria-hidden="true" />,
    },
  ];

  return (
    <div className="insights" data-view={view}>
      <PageTitle title={m.overview_insights_title()} />
      <div className="insights-toolbar">
        <CollectionViews<InsightView>
          label={m.insights_views_label()}
          value={view}
          views={views}
          onChange={(next) => scoped({ view: next })}
        />
        <div
          className="insights-toolbar-filters"
          role="group"
          aria-label={m.common_filters()}
        >
          {view === 'outcomes' ? (
            reporting === undefined ? null : reporting ? (
              <ResolutionReportFilters
                organizationId={organizationId}
                search={search}
                onSearch={onSearch}
              />
            ) : (
              <OutcomeFilters
                environment={environment}
                window={window}
                onEnvironmentChange={(next) =>
                  onSearch({ outcomeEnv: next === 'live' ? undefined : next })
                }
                onWindowChange={(next) =>
                  onSearch({ outcomeWindow: next === '7d' ? undefined : next })
                }
              />
            )
          ) : (
            <>
              {view === 'trends' && (
                <ToggleGroup
                  aria-label={m.insights_filter_range()}
                  value={[search.range ?? '30d']}
                  onValueChange={(value: string[]) => {
                    const range = insightRanges.find(
                      (candidate) => candidate === value[0],
                    );
                    if (range)
                      scoped({ range: range === '30d' ? undefined : range });
                  }}
                >
                  {insightRanges.map((range) => (
                    <ToggleGroupItem key={range} value={range}>
                      {rangeShortLabels[range]()}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
              <SourceFilter
                organizationId={organizationId}
                value={search.source}
                onChange={(source) => scoped({ source })}
              />
            </>
          )}
        </div>
        <div className="insights-toolbar-status">
          <DataHealth
            organizationId={organizationId}
            data={live.operational.isError ? undefined : live.operational.data}
          />
          <LiveStatus connection={read.connection} failed={read.isError} />
          <RefreshButton
            size="icon-sm"
            label={m.insights_refresh()}
            refreshing={refreshing}
            onClick={refresh}
            disabled={
              read.connection === 'denied' || read.connection === 'offline'
            }
          />
        </div>
      </div>
      {view === 'now' ? (
        <>
          <AttentionSummary
            operational={live.operational}
            orders={live.orders}
            operationalInspector={operationalInspector}
            ordersInspector={ordersInspector}
          />
          <OperationalMetrics
            key={`summary-${organizationId}`}
            organizationId={organizationId}
            live={live.operational}
            metricGroups={nowGroups}
            description={m.insights_pulse_description()}
            embedded
            inspector={operationalInspector}
            leading={
              <OrderMetrics
                key={organizationId}
                organizationId={organizationId}
                live={live.orders}
                variant="group"
                inspector={ordersInspector}
              />
            }
          />
          <InsightsSection
            title={m.insights_now_backlog_title()}
            description={m.insights_now_backlog_description()}
          >
            <InsightCharts
              key={`now-${organizationId}`}
              organizationId={organizationId}
              charts={currentStateCharts}
              layout="columns"
              search={search}
              returnPath={location.href}
              onSearch={onSearch}
            />
          </InsightsSection>
        </>
      ) : view === 'trends' ? (
        <InsightsSection
          title={m.insights_trends_title()}
          description={m.insights_trends_description()}
        >
          <InsightCharts
            key={`trends-${organizationId}`}
            organizationId={organizationId}
            charts={trendCharts}
            layout="stacked"
            search={search}
            returnPath={location.href}
            onSearch={onSearch}
          />
        </InsightsSection>
      ) : (
        <>
          {reporting ? (
            <ResolutionReport
              key={`report-${organizationId}`}
              organizationId={organizationId}
              search={search}
              onSearch={onSearch}
              request={report.request}
              live={live.resolution}
            />
          ) : (
            <ResolutionOutcomes
              key={`resolution-${organizationId}`}
              organizationId={organizationId}
              live={live.resolution}
              environment={environment}
              window={window}
            />
          )}
          <PurchasingOutcomePanel organizationId={organizationId} />
        </>
      )}
    </div>
  );
}

/** A titled part of a view. */
function InsightsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const id = useId();

  return (
    <section className="insights-section" aria-labelledby={id}>
      <header className="insights-section-header">
        <h2 id={id}>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}

/**
 * Scopes source-backed charts to one connection. Disconnected and revoked connections are not
 * offered, but one already in the address stays selected so the view it names keeps working.
 */
function SourceFilter({
  organizationId,
  value,
  onChange,
}: {
  organizationId: string;
  value: string | undefined;
  onChange: (source: string | undefined) => void;
}) {
  const connections = useQuery(connectionsOptions(organizationId)).data ?? [];
  const sources = connections.filter(
    (connection) =>
      connection.id === value ||
      !['disconnected', 'revoked'].includes(connection.status),
  );

  return (
    <Select
      className="insights-filter"
      aria-label={m.common_source()}
      value={value ?? 'all'}
      options={[
        { value: 'all', label: m.insights_filter_source_all() },
        ...sources.map((connection) => ({
          value: connection.id,
          label: connection.label,
        })),
      ]}
      onValueChange={(source) =>
        onChange(source && source !== 'all' ? source : undefined)
      }
    />
  );
}

/**
 * Says whether the connections behind every number are current, and opens Data sync, where
 * each connection's reads can be inspected, when some need attention. Shows nothing until the
 * summary has been read, so an unknown state never reads as healthy.
 */
function DataHealth({
  organizationId,
  data,
}: {
  organizationId: string;
  data: OperationalMetricResponse | undefined;
}) {
  const metric = data?.metrics.find(
    (candidate) => candidate.definition.id === 'connections.needing_attention',
  );
  if (!metric || metric.value === null) return null;
  const params = { organizationId };
  if (!metric.population)
    return (
      <Link
        className="insights-health"
        data-state="idle"
        to="/app/$organizationId/apps"
        params={params}
      >
        <StateDot state="idle" />
        {m.insights_health_none()}
      </Link>
    );

  return (
    <Link
      className="insights-health"
      data-state={metric.value ? 'attention' : 'verified'}
      to="/app/$organizationId/sync"
      params={params}
    >
      <StateDot state={metric.value ? 'attention' : 'verified'} />
      {metric.value
        ? m.insights_health_attention({
            count: metric.value,
            value: formatNumber(metric.value),
          })
        : m.insights_health_current()}
    </Link>
  );
}

/**
 * Names the state of the page's live updates. It describes delivery only; source freshness and
 * coverage are stated next to each number.
 */
function LiveStatus({
  connection,
  failed,
}: {
  connection: LiveConnection;
  failed: boolean;
}) {
  const [label, state] =
    connection === 'denied'
      ? [m.overview_live_access_changed(), 'error' as const]
      : connection === 'offline'
        ? [m.overview_live_offline(), 'attention' as const]
        : failed
          ? [m.overview_live_unavailable(), 'attention' as const]
          : connection === 'live'
            ? [m.overview_live_on(), 'running' as const]
            : connection === 'syncing'
              ? [m.overview_live_updating(), 'running' as const]
              : connection === 'reconnecting'
                ? [m.overview_live_reconnecting(), 'waiting' as const]
                : [m.overview_live_connecting(), 'waiting' as const];

  return (
    <span className="insights-live" data-state={state} role="status">
      <StateDot state={state} />
      {label}
    </span>
  );
}
