import { Button } from '@luma/ui/button';
import {
  CaseInvestigation,
  CaseLoading,
  CaseNotice,
} from '@luma/ui/components/case-investigation';
import { CaseTimeline } from '@luma/ui/components/case-timeline';

import type { CaseObservation } from './observation';

/**
 * Keeps a selected case investigation and history current through progress events and query
 * refreshes.
 */
export function LiveCaseDetail({
  observation,
}: {
  observation: CaseObservation;
}) {
  const {
    snapshot,
    history,
    denied,
    confirmed,
    connection,
    restart: refresh,
  } = observation;
  if (denied)
    return (
      <CaseNotice error title="Case unavailable">
        This case is missing or you no longer have access.
      </CaseNotice>
    );
  const data = snapshot.data;
  if (!data)
    return snapshot.isPending ? (
      <CaseLoading />
    ) : (
      <CaseNotice error title="Progress could not be confirmed">
        Refresh to read the latest case state.
        <Button variant="outline" onClick={refresh}>
          Refresh progress
        </Button>
      </CaseNotice>
    );

  return (
    <CaseInvestigation
      item={data.detail}
      embedded
      unconfirmed={!confirmed}
      onRefresh={refresh}
      refreshing={snapshot.isFetching}
      progress={
        <CaseTimeline
          {...data}
          timeline={history.data?.timeline ?? []}
          evidence={history.data?.evidence ?? []}
          historyUnavailable={history.isError || history.isPending}
          hasMoreTimeline={history.data?.hasMoreTimeline ?? false}
          hasMoreEvidence={history.data?.hasMoreEvidence ?? false}
          loadingHistory={history.isFetching}
          onLoadMore={observation.loadMore}
          connection={connection}
          confirmed={confirmed}
          onRefresh={refresh}
        >
          {history.isError ? (
            <CaseNotice error title="History could not be refreshed">
              {history.data ? 'Showing previously loaded history. ' : ''}
              The current case review is shown separately.
              <Button variant="outline" onClick={observation.retryHistory}>
                Retry history
              </Button>
            </CaseNotice>
          ) : history.isPending ? (
            <CaseLoading />
          ) : null}
        </CaseTimeline>
      }
    />
  );
}
