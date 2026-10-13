import { m } from '@luma/i18n/messages';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { OperationalCharts } from '../insights/charts';
import type { InsightsSearch } from '../insights/data';
import { useLiveMetricSummary } from './metrics-live';
import { OperationalMetrics } from './operational-metrics';
import { operationalMetricRequest } from './operational-metrics-data';
import { orderMetricRequest, OrderMetrics } from './order-metrics';
import {
  type OutcomeEnvironment,
  type OutcomeWindow,
  resolutionMetricRequest,
  ResolutionOutcomes,
} from './resolution-outcomes';
import { ResolutionReport, useResolutionReporting } from './resolution-report';

/**
 * Shows live operational metrics, trends over time and order flow, with drill-downs into the
 * matching records. The metric sections share one live summary read.
 */
export function InsightsPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/insights',
  });
  const search = useSearch({ from: '/app/$organizationId/insights' });
  const navigate = useNavigate({ from: '/app/$organizationId/insights' });
  const location = useLocation();
  const [environment, setEnvironment] = useState<OutcomeEnvironment>('live');
  const [window, setWindow] = useState<OutcomeWindow>('7d');
  const reporting = useResolutionReporting(organizationId);
  const resolution = useMemo(
    () => resolutionMetricRequest(environment, window),
    [environment, window],
  );
  const live = useLiveMetricSummary(organizationId, {
    operational: operationalMetricRequest,
    resolution: reporting ? undefined : resolution,
    orders: orderMetricRequest,
  });

  return (
    <div className="insights">
      <PageTitle title={m.overview_insights_title()} />
      <OperationalMetrics
        key={`summary-${organizationId}`}
        organizationId={organizationId}
        live={live.operational}
      />
      <OperationalCharts
        key={`charts-${organizationId}`}
        organizationId={organizationId}
        search={search}
        returnPath={location.href}
        onSearch={(patch: Partial<InsightsSearch>) =>
          void navigate({
            search: (previous) => ({ ...previous, ...patch }),
            resetScroll: false,
          })
        }
      />
      {reporting ? (
        <ResolutionReport
          key={`report-${organizationId}`}
          organizationId={organizationId}
          search={search}
          onSearch={(patch) =>
            void navigate({
              search: (previous) => ({ ...previous, ...patch }),
              resetScroll: false,
            })
          }
        />
      ) : (
        <ResolutionOutcomes
          key={`resolution-${organizationId}`}
          organizationId={organizationId}
          live={live.resolution}
          environment={environment}
          window={window}
          onEnvironmentChange={setEnvironment}
          onWindowChange={setWindow}
        />
      )}
      <OrderMetrics
        key={organizationId}
        organizationId={organizationId}
        live={live.orders}
      />
    </div>
  );
}
