import { caseLabel } from '@luma/ui/components/issues/case-investigation';
import { IssuePageLayout } from '@luma/ui/components/issues/issue-page-layout';
import { Button } from '@luma/ui/components/primitives/button';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useLocation,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react';
import { z } from 'zod';

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
  const location = useLocation();
  const observation = useCaseObservation(organizationId, exceptionId);
  const connections = useQuery(connectionsOptions(organizationId));
  const item = observation.denied
    ? undefined
    : observation.snapshot.data?.detail;
  const connection =
    item?.subject.kind === 'connection'
      ? connections.data?.find(({ id }) => id === item.subject.id)
      : undefined;

  return (
    <IssuePageLayout
      item={item}
      back={
        <>
          <Link
            to="/app/$organizationId/exceptions/$exceptionId"
            params={{ organizationId, exceptionId }}
            search={search}
            aria-label="Back to issues"
          >
            <ArrowLeft size={16} aria-hidden="true" /> Issues
          </Link>
          {item?.subject.kind === 'sku' ? (
            <Link
              to="/app/$organizationId/inventory"
              params={{ organizationId }}
              search={{
                q: item.subject.id,
                connectionId: connections.data?.find((connection) =>
                  item.subject.scope.includes(connection.id),
                )?.id,
                from: `${location.pathname}${location.searchStr}`,
              }}
            >
              Inspect inventory <ArrowRight size={14} />
            </Link>
          ) : null}
          {item?.subject.kind === 'sku' ? (
            <Link
              to="/app/$organizationId/products"
              params={{ organizationId }}
              search={{
                q: item.subject.id,
                from: `${location.pathname}${location.searchStr}`,
              }}
            >
              Inspect product <ArrowRight size={14} />
            </Link>
          ) : null}
          {connection ? (
            <Link
              to={
                connection.appId
                  ? '/app/$organizationId/apps/$appId/settings'
                  : '/app/$organizationId/apps'
              }
              params={{ organizationId, appId: connection.appId ?? '' }}
              hash={`connection-${connection.id}`}
            >
              {connection.status === 'active'
                ? 'Open connection'
                : `Reconnect ${connection.label}`}{' '}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          ) : null}
          {item?.subject.kind === 'fulfillment' ? (
            z.string().uuid().safeParse(item.subject.id).success ? (
              <Link
                to="/app/$organizationId/fulfillment/$fulfillmentId"
                params={{ organizationId, fulfillmentId: item.subject.id }}
                search={{ from: `${location.pathname}${location.searchStr}` }}
              >
                Inspect fulfillment <ArrowRight size={14} />
              </Link>
            ) : (
              <Link
                to="/app/$organizationId/fulfillment"
                params={{ organizationId }}
                search={{
                  q: item.subject.id,
                  view: 'all',
                  from: `${location.pathname}${location.searchStr}`,
                }}
              >
                Inspect fulfillment <ArrowRight size={14} />
              </Link>
            )
          ) : null}
          {item ? (
            <Link
              to="/app/$organizationId/records"
              params={{ organizationId }}
              search={{
                q: item.subject.id,
                connectionId: z.string().uuid().safeParse(item.subject.scope[0])
                  .success
                  ? item.subject.scope[0]
                  : undefined,
                from: `${location.pathname}${location.searchStr}`,
              }}
              aria-label="Find underlying records"
            >
              Find records <ArrowRight size={14} aria-hidden="true" />
            </Link>
          ) : null}
        </>
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
