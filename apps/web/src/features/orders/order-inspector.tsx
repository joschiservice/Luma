import type { OrderDetail } from '@luma/api-contract';
import { formatTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { issueKind } from '@luma/ui/components/issues/case-presentation';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  ChevronRight,
  Database,
  Inbox,
  Link2,
  type LucideIcon,
  Workflow,
} from 'lucide-react';
import type { ReactNode } from 'react';

import {
  connectionStatusLabel,
  issueStateLabel,
  runStateLabel,
} from '../../shared/orders/presentation';
import { linkMethodLabel } from '../sync/presentation';

function InspectorCard({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card as="section" aria-label={title}>
      <CardHeader>
        <CardTitle as="h2">
          <Icon aria-hidden="true" />
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** The first SKU code or title any source reports for an ordered SKU. */
function skuLabel(detail: OrderDetail, skuId: string) {
  const line = detail.sources
    .flatMap((source) => source.lines)
    .find((item) => item.skuId === skuId && (item.skuCode || item.title));

  return line?.skuCode ?? line?.title ?? m.orders_inspector_stock_item();
}

/** Ordered SKUs whose stock gap Luma is letting provider sync close; they are not issues yet. */
function StockSync({
  detail,
  organizationId,
}: {
  detail: OrderDetail;
  organizationId: string;
}) {
  if (!detail.stockSync.length) return null;

  return (
    <ul className="order-list">
      {detail.stockSync.map((wait) => (
        <li key={wait.skuId}>
          <Link
            className="order-row-link"
            to="/app/$organizationId/inventory"
            params={{ organizationId }}
            search={{ skuId: wait.skuId }}
          >
            <span className="orders-cell-stack">
              <strong>{skuLabel(detail, wait.skuId)}</strong>
              <small>
                {m.orders_inspector_stock_syncing({
                  until: formatTime(wait.until),
                })}
              </small>
            </span>
            <StatePill state="waiting">
              {m.orders_inspector_syncing()}
            </StatePill>
            <ChevronRight className="order-row-chevron" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function OrderIssues({
  issues,
  organizationId,
}: {
  issues: OrderDetail['issues'];
  organizationId: string;
}) {
  if (!issues.length)
    return <p className="order-note">{m.orders_inspector_no_issues()}</p>;

  return (
    <ul className="order-list">
      {issues.map((issue) => (
        <li key={issue.id}>
          <Link
            className="order-row-link"
            to="/app/$organizationId/exceptions/$exceptionId"
            params={{ organizationId, exceptionId: issue.id }}
            search={{
              view:
                issue.state === 'resolved'
                  ? 'history'
                  : issue.needsYou
                    ? 'needs_you'
                    : 'active',
            }}
          >
            <span className="orders-cell-stack">
              <strong>{issueKind(issue).label}</strong>
              <small>
                {issueStateLabel(issue.state)}
                {' · '}
                {issue.relationship === 'sku'
                  ? m.orders_inspector_issue_sku()
                  : issue.relationship === 'fulfillment'
                    ? m.orders_inspector_issue_fulfillment()
                    : m.orders_inspector_issue_order()}
                {issue.occurrences > 1
                  ? ` · ${m.orders_inspector_issue_occurrences({ count: issue.occurrences })}`
                  : null}
              </small>
            </span>
            {issue.needsYou ? (
              <StatePill state="attention">
                {m.orders_flag_needs_you()}
              </StatePill>
            ) : null}
            <ChevronRight className="order-row-chevron" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function WorkflowRuns({
  runs,
  organizationId,
}: {
  runs: OrderDetail['workflows'];
  organizationId: string;
}) {
  if (!runs.length)
    return <p className="order-note">{m.orders_inspector_no_runs()}</p>;

  return (
    <ul className="order-list">
      {runs.map((run) => (
        <li key={run.id}>
          <Link
            className="order-row-link"
            to="/app/$organizationId/workflows/$definitionId"
            params={{ organizationId, definitionId: run.definitionId }}
          >
            <span className="orders-cell-stack">
              <strong>{run.name ?? run.definitionId}</strong>
              <small>
                {runStateLabel(run.state)}
                {' · '}
                {m.orders_inspector_run_version({ version: run.version })}
                {run.createdAt ? (
                  <>
                    {' · '}
                    <WorkspaceDate value={run.createdAt} />
                  </>
                ) : null}
              </small>
            </span>
            <ChevronRight className="order-row-chevron" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function OrderSources({ sources }: { sources: OrderDetail['sources'] }) {
  return (
    <ul className="order-list">
      {sources.map((source) => (
        <li key={source.connectionId}>
          <span className="orders-cell-stack">
            <strong>
              {source.selected
                ? m.orders_source_shown({ source: source.label })
                : source.label}
            </strong>
            <small>
              {source.mappingMethod
                ? linkMethodLabel(source.mappingMethod)
                : m.orders_inspector_link_unrecorded()}
            </small>
            <small>
              {source.sourceUpdatedAt
                ? rich(m.orders_inspector_source_times, {
                    updated: <WorkspaceDate value={source.sourceUpdatedAt} />,
                    read: <WorkspaceDate value={source.observedAt} />,
                  })
                : rich(m.orders_inspector_source_times_unreported, {
                    read: <WorkspaceDate value={source.observedAt} />,
                  })}
            </small>
          </span>
          <Badge
            tone={
              source.deleted || source.connectionStatus !== 'active'
                ? 'warning'
                : 'neutral'
            }
          >
            {source.deleted
              ? m.orders_inspector_removed_at_source()
              : connectionStatusLabel(source.connectionStatus)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * Shows the order's linked issues, workflow runs and sources beside the record. `here` is the
 * order path that the raw record view links back to; `manageLinks` opens the source links.
 * `linkSuggestions` points to links Luma suggests.
 */
export function OrderInspector({
  detail,
  organizationId,
  here,
  manageLinks,
  linkSuggestions,
}: {
  detail: OrderDetail;
  organizationId: string;
  here: string;
  manageLinks?: (() => void) | undefined;
  /** Suggested links to orders in other sources, with the control that reviews them. */
  linkSuggestions?: ReactNode;
}) {
  return (
    <aside className="order-inspector" aria-label={m.orders_inspector_label()}>
      <InspectorCard title={m.orders_inspector_issues()} icon={Inbox}>
        <StockSync detail={detail} organizationId={organizationId} />
        <OrderIssues issues={detail.issues} organizationId={organizationId} />
      </InspectorCard>
      <InspectorCard title={m.orders_inspector_runs()} icon={Workflow}>
        <WorkflowRuns runs={detail.workflows} organizationId={organizationId} />
      </InspectorCard>
      <InspectorCard
        title={m.orders_inspector_sources()}
        icon={Database}
        action={
          <Link
            className="order-card-link"
            to="/app/$organizationId/records/$kind/$recordId"
            params={{
              organizationId,
              kind: 'order',
              recordId: detail.order.id,
            }}
            search={{ from: here }}
          >
            {m.orders_inspector_open_records()}
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
        }
      >
        <OrderSources sources={detail.sources} />
        {linkSuggestions}
        {manageLinks ? (
          <Button
            className="order-inspector-action"
            variant="outline"
            size="sm"
            onClick={manageLinks}
          >
            <Link2 aria-hidden="true" />
            {m.orders_links_manage()}
          </Button>
        ) : null}
      </InspectorCard>
    </aside>
  );
}
