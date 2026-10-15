import { m } from '@luma/i18n/messages';
import { caseLabel } from '@luma/ui/components/issues/case-investigation';
import { IssuePageLayout } from '@luma/ui/components/issues/issue-page-layout';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useLocation,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { z } from 'zod';

import { connectionsOptions } from '../../kit/connections/data';
import { RecordAssistance } from '../../kit/record-assistance';
import { StockProtectionNotice } from '../../shared/stock-protection/notice';
import { CaseOrderChangePlan } from '../orders/change-plan';
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
        <Link
          to="/app/$organizationId/exceptions/$exceptionId"
          params={{ organizationId, exceptionId }}
          search={search}
          aria-label={m.exceptions_back_label()}
        >
          <ArrowLeft size={16} aria-hidden="true" /> {m.exceptions_back_text()}
        </Link>
      }
      links={
        <>
          {item ? (
            <RecordAssistance
              organizationId={organizationId}
              context={{ record: { kind: 'issue', id: item.id } }}
              label={caseLabel(item.class)}
            />
          ) : null}

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
              {m.exceptions_inspect_inventory()} <ArrowRight size={14} />
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
              {m.exceptions_inspect_product()} <ArrowRight size={14} />
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
                ? m.exceptions_open_connection()
                : m.exceptions_reconnect({ connection: connection.label })}{' '}
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
                {m.exceptions_inspect_fulfillment()} <ArrowRight size={14} />
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
                {m.exceptions_inspect_fulfillment()} <ArrowRight size={14} />
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
              aria-label={m.exceptions_find_records_label()}
            >
              {m.exceptions_find_records()}{' '}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          ) : null}
        </>
      }
      refresh={<RefreshButton onClick={observation.restart} />}
      canReview={Boolean(
        item &&
        observation.snapshot.data?.review.proposal &&
        observation.snapshot.data.review.permittedDecisions.some(
          (decision) => decision === 'approve' || decision === 'reject',
        ),
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
                m.exceptions_connection_label({
                  connection: connection.label,
                  system: caseLabel(connection.target.kind),
                }),
              ]),
            )}
          />
        ) : null
      }
    >
      {item?.class === 'stock_sync_stall' ? (
        <StockProtectionNotice
          organizationId={organizationId}
          incidentId={exceptionId}
        />
      ) : null}
      <LiveCaseDetail observation={observation} expanded />
      {item ? (
        <CaseOrderChangePlan
          organizationId={organizationId}
          subject={item.subject}
          from={`${location.pathname}${location.searchStr}`}
        />
      ) : null}
    </IssuePageLayout>
  );
}
