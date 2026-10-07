import { PageTitle } from '@luma/ui/components/workspace/page-header';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';

import { OperationalCharts } from '../insights/charts';
import type { InsightsSearch } from '../insights/data';
import { OperationalMetrics } from './operational-metrics';
import { OrderMetrics } from './order-metrics';
import { ResolutionOutcomes } from './resolution-outcomes';

/**
 * Shows live operational metrics, trends over time and order flow, with drill-downs into the
 * matching records.
 */
export function InsightsPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/insights',
  });
  const search = useSearch({ from: '/app/$organizationId/insights' });
  const navigate = useNavigate({ from: '/app/$organizationId/insights' });
  const location = useLocation();

  return (
    <div className="insights">
      <PageTitle title="Insights" />
      <OperationalMetrics
        key={`summary-${organizationId}`}
        organizationId={organizationId}
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
      <ResolutionOutcomes
        key={`resolution-${organizationId}`}
        organizationId={organizationId}
      />
      <OrderMetrics key={organizationId} organizationId={organizationId} />
    </div>
  );
}
