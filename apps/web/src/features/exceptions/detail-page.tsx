import { caseLabel } from '@luma/ui/components/issues/case-investigation';
import { IssuePageLayout } from '@luma/ui/components/issues/issue-page-layout';
import { Button } from '@luma/ui/components/primitives/button';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, RefreshCw } from 'lucide-react';

import { connectionsOptions } from '../connections/data';
import { IssueActions } from './actions';
import { useCaseObservation } from './observation';
import { LiveCaseDetail } from './progress';

/** Opens a shareable issue workspace and preserves inbox filters on return. */
export function IssueDetailPage() {
  const { organizationId, exceptionId } = useParams({
    from: '/app/$organizationId/exceptions_/$exceptionId/detail',
  });

  return (
    <IssueWorkspace
      key={`${organizationId}:${exceptionId}`}
      organizationId={organizationId}
      exceptionId={exceptionId}
    />
  );
}

function IssueWorkspace({
  organizationId,
  exceptionId,
}: {
  organizationId: string;
  exceptionId: string;
}) {
  const search = useSearch({
    from: '/app/$organizationId/exceptions_/$exceptionId/detail',
  });
  const observation = useCaseObservation(organizationId, exceptionId);
  const connections = useQuery(connectionsOptions(organizationId));
  const item = observation.denied
    ? undefined
    : observation.snapshot.data?.detail;

  return (
    <IssuePageLayout
      item={item}
      back={
        <Link
          to="/app/$organizationId/exceptions/$exceptionId"
          params={{ organizationId, exceptionId }}
          search={search}
          aria-label="Back to issues"
        >
          <ArrowLeft size={16} aria-hidden="true" /> Issues
        </Link>
      }
      refresh={
        <Button
          variant="outline"
          aria-label="Refresh"
          disabled={observation.snapshot.isFetching}
          onClick={observation.restart}
        >
          <RefreshCw size={14} aria-hidden="true" />
          <span className="issue-page-desktop-label">Refresh</span>
        </Button>
      }
      canReview={Boolean(
        item && observation.snapshot.data?.review.permittedDecisions.length,
      )}
      actions={
        item ? (
          <IssueActions
            organizationId={organizationId}
            exceptionId={exceptionId}
            observation={observation}
            initialWorkflow={search.shadow}
            connectionLabels={Object.fromEntries(
              (connections.data ?? []).map((connection) => [
                connection.id,
                `${connection.label} · ${caseLabel(connection.target.kind)}`,
              ]),
            )}
          />
        ) : null
      }
    >
      <LiveCaseDetail observation={observation} expanded />
    </IssuePageLayout>
  );
}
