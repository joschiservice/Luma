import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useParams } from '@tanstack/react-router';

import { OperationalMetrics } from './operational-metrics';
import { OrderMetrics } from './order-metrics';

/** Shows live operational metrics and order flow, with drill-downs into matching records. */
export function InsightsPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/insights',
  });

  return (
    <div className="insights">
      <PageHeader
        title="Insights"
        description="Live counts across your operations and how orders move through them. Select a metric to see the records behind it."
      />
      <OperationalMetrics
        key={`summary-${organizationId}`}
        organizationId={organizationId}
      />
      <OrderMetrics key={organizationId} organizationId={organizationId} />
    </div>
  );
}
