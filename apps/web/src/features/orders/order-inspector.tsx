import type { OrderDetail } from '@luma/api-contract';
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
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Copy } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import {
  connectionStatusLabel,
  issueStateLabel,
  runStateLabel,
} from './presentation';

function InspectorCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card as="section" aria-label={title}>
      <CardHeader>
        <CardTitle as="h2">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function OrderActions({
  detail,
  organizationId,
  here,
}: {
  detail: OrderDetail;
  organizationId: string;
  here: string;
}) {
  const [copied, setCopied] = useState(false);
  const needsYou = detail.issues.find((issue) => issue.needsYou);

  return (
    <Card as="section" aria-label={m.common_actions()}>
      <CardContent className="order-actions">
        {needsYou ? (
          <Link
            className="order-primary-action"
            to="/app/$organizationId/exceptions/$exceptionId"
            params={{ organizationId, exceptionId: needsYou.id }}
            search={{ view: 'needs_you' }}
          >
            {m.orders_inspector_review_issue()}{' '}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        ) : null}
        <Link
          to="/app/$organizationId/records/$kind/$recordId"
          params={{ organizationId, kind: 'order', recordId: detail.order.id }}
          search={{ from: here }}
        >
          {m.orders_inspector_open_records()}{' '}
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(new URL(here, window.location.origin).href)
              .then(() => setCopied(true));
          }}
        >
          <Copy aria-hidden="true" /> {m.orders_inspector_copy_link()}
        </Button>
        <span role="status" className="order-note">
          {copied ? m.orders_inspector_link_copied() : ''}
        </span>
      </CardContent>
    </Card>
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
            </small>
          </span>
          {issue.needsYou ? (
            <StatePill state="attention">{m.orders_flag_needs_you()}</StatePill>
          ) : null}
          <Link
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
            aria-label={m.orders_inspector_open_issue({
              issue: issueKind(issue).label,
            })}
          >
            {m.common_open()}
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
          <Link
            to="/app/$organizationId/workflows/$definitionId"
            params={{ organizationId, definitionId: run.definitionId }}
            aria-label={m.orders_inspector_open_workflow({
              workflow: run.name ?? run.definitionId,
            })}
          >
            {m.common_open()}
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
              {source.externalId
                ? m.orders_inspector_source_id({ id: source.externalId })
                : m.orders_inspector_source_id_missing()}
            </small>
            <small>
              {source.mappingMethod
                ? source.mappingMethod.startsWith('Imported')
                  ? m.orders_inspector_link_imported()
                  : source.mappingMethod.startsWith('Linked')
                    ? m.orders_inspector_link_linked()
                    : source.mappingMethod.startsWith('Unlinked')
                      ? m.orders_inspector_link_unlinked()
                      : m.orders_inspector_link_confirmed({
                          method: source.mappingMethod.replaceAll('-', ' '),
                        })
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
 * Shows the order's actions, linked issues, workflow runs, sources and Luma identity beside the
 * record. `here` is the order path used for copied links and record back links.
 */
export function OrderInspector({
  detail,
  organizationId,
  here,
}: {
  detail: OrderDetail;
  organizationId: string;
  here: string;
}) {
  return (
    <aside className="order-inspector" aria-label={m.orders_inspector_label()}>
      <OrderActions
        detail={detail}
        organizationId={organizationId}
        here={here}
      />
      <InspectorCard title={m.orders_inspector_issues()}>
        <OrderIssues issues={detail.issues} organizationId={organizationId} />
      </InspectorCard>
      <InspectorCard title={m.orders_inspector_runs()}>
        <WorkflowRuns runs={detail.workflows} organizationId={organizationId} />
      </InspectorCard>
      <InspectorCard title={m.orders_inspector_sources()}>
        <OrderSources sources={detail.sources} />
      </InspectorCard>
      <Disclosure>
        <summary>{m.orders_inspector_identity_title()}</summary>
        <p className="order-note">
          {rich(m.orders_inspector_identity_body, {
            id: <code>{detail.order.id}</code>,
          })}
        </p>
      </Disclosure>
    </aside>
  );
}
