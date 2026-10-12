import { m } from '@luma/i18n/messages';
import {
  CaseInvestigation,
  CaseLoading,
  CaseNotice,
} from '@luma/ui/components/issues/case-investigation';
import { CaseTimeline } from '@luma/ui/components/issues/case-timeline';
import { Button } from '@luma/ui/components/primitives/button';

import type { CaseObservation } from './observation';
import { CaseOwnerControl } from './owner';

/**
 * Keeps a selected case investigation and history current through progress events and query
 * refreshes.
 */
export function LiveCaseDetail({
  observation,
  expanded = false,
}: {
  observation: CaseObservation;
  expanded?: boolean;
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
      <CaseNotice error title={m.exceptions_issue_unavailable()}>
        {m.exceptions_detail_denied_text()}
      </CaseNotice>
    );
  const data = snapshot.data;
  if (!data)
    return snapshot.isPending ? (
      <CaseLoading />
    ) : (
      <CaseNotice error title={m.exceptions_progress_failed_title()}>
        {m.exceptions_progress_failed_text()}
        <Button variant="outline" onClick={refresh}>
          {m.exceptions_progress_refresh()}
        </Button>
      </CaseNotice>
    );

  return (
    <>
      <CaseOwnerControl
        organizationId={observation.organizationId}
        item={data.detail}
        onChange={observation.refresh}
      />
      <CaseInvestigation
        item={data.detail}
        review={data.review}
        embedded
        expanded={expanded}
        unconfirmed={!confirmed}
        onRefresh={refresh}
        refreshing={snapshot.isFetching}
        progress={
          <>
            <CaseTimeline
              expanded={expanded}
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
                <CaseNotice error title={m.exceptions_history_failed_title()}>
                  {history.data
                    ? m.exceptions_history_failed_stale()
                    : m.exceptions_history_failed_text()}
                  <Button variant="outline" onClick={observation.retryHistory}>
                    {m.exceptions_history_retry()}
                  </Button>
                </CaseNotice>
              ) : history.isPending ? (
                <CaseLoading />
              ) : null}
            </CaseTimeline>
          </>
        }
      />
    </>
  );
}
