import { OperationsOverview } from '@luma/ui/components/overview/operations-overview';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';

import { overviewOptions } from './data';
import { OperationalMetrics } from './operational-metrics';
import { OrderMetrics } from './order-metrics';

/**
 * Displays the current workspace's operations summary with loading, error, and refresh
 * states.
 */
export function OverviewPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/home',
  });
  const { window } = useSearch({ from: '/app/$organizationId/home' });
  const navigate = useNavigate({ from: '/app/$organizationId/home' });
  const result = useQuery(overviewOptions(organizationId, window));

  return (
    <>
      <OperationsOverview
        data={result.isError || result.isPaused ? undefined : result.data}
        paused={result.isPaused}
        loading={result.isPending}
        error={result.isError}
        refreshing={result.isFetching}
        window={window}
        onWindowChange={(value) => void navigate({ search: { window: value } })}
        onRefresh={() => void result.refetch()}
        connectionsLink={
          <Link to="/app/$organizationId/apps" params={{ organizationId }}>
            Manage connections →
          </Link>
        }
        inboxLink={
          <Link
            to="/app/$organizationId/exceptions"
            params={{ organizationId }}
            search={{ view: 'needs_you' }}
          >
            Open attention inbox →
          </Link>
        }
        decisionLink={(item) => (
          <Link
            to="/app/$organizationId/exceptions/$exceptionId"
            params={{ organizationId, exceptionId: item.id }}
            search={{ view: 'needs_you' }}
          >
            {item.summary.replace(/\.+$/, '')}
          </Link>
        )}
      />
      <OperationalMetrics
        key={`summary-${organizationId}`}
        organizationId={organizationId}
      />
      <OrderMetrics key={organizationId} organizationId={organizationId} />
    </>
  );
}
