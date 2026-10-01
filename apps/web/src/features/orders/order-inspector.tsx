import type { OrderDetail } from '@luma/api-contract';
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
    <Card as="section" aria-label="Actions">
      <CardContent className="order-actions">
        {needsYou ? (
          <Link
            className="order-primary-action"
            to="/app/$organizationId/exceptions/$exceptionId"
            params={{ organizationId, exceptionId: needsYou.id }}
            search={{ view: 'needs_you' }}
          >
            Review issue <ArrowRight size={14} aria-hidden="true" />
          </Link>
        ) : null}
        <Link
          to="/app/$organizationId/records/$kind/$recordId"
          params={{ organizationId, kind: 'order', recordId: detail.order.id }}
          search={{ from: here }}
        >
          Open in Records <ArrowRight size={14} aria-hidden="true" />
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
          <Copy aria-hidden="true" /> Copy link
        </Button>
        <span role="status" className="order-note">
          {copied ? 'Link copied.' : ''}
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
  if (!issues.length) return <p className="order-note">No linked issues.</p>;

  return (
    <ul className="order-list">
      {issues.map((issue) => (
        <li key={issue.id}>
          <span className="orders-cell-stack">
            <strong>{issueKind(issue).label}</strong>
            <small>
              {issue.state === 'resolved'
                ? 'Resolved'
                : issue.state.replaceAll('_', ' ')}
              {' · '}
              {issue.relationship === 'sku'
                ? 'Affects an ordered item'
                : issue.relationship === 'fulfillment'
                  ? 'On a fulfillment'
                  : 'On this order'}
            </small>
          </span>
          {issue.needsYou ? (
            <StatePill state="attention">Needs you</StatePill>
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
            aria-label={`Open ${issueKind(issue).label} issue`}
          >
            Open
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
    return (
      <p className="order-note">
        No workflow has run for this order or its issues.
      </p>
    );

  return (
    <ul className="order-list">
      {runs.map((run) => (
        <li key={run.id}>
          <span className="orders-cell-stack">
            <strong>{run.name ?? run.definitionId}</strong>
            <small>
              {run.state.replaceAll('_', ' ')} · version {run.version}
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
            aria-label={`Open workflow ${run.name ?? run.definitionId}`}
          >
            Open
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
              {source.label}
              {source.selected ? ' · shown' : ''}
            </strong>
            <small>Source ID {source.externalId ?? 'not mapped'}</small>
            <small>
              {source.mappingMethod
                ? source.mappingMethod.startsWith('Imported')
                  ? 'Imported from this source'
                  : source.mappingMethod.startsWith('Linked')
                    ? 'Linked by a person'
                    : source.mappingMethod.startsWith('Unlinked')
                      ? 'Unlinked by a person'
                      : `Link confirmed: ${source.mappingMethod.replaceAll('-', ' ')}`
                : 'Link method not recorded'}
            </small>
            <small>
              Updated{' '}
              {source.sourceUpdatedAt ? (
                <WorkspaceDate value={source.sourceUpdatedAt} />
              ) : (
                'time not reported'
              )}{' '}
              · Read <WorkspaceDate value={source.observedAt} />
            </small>
          </span>
          <Badge
            tone={
              source.deleted || source.connectionStatus !== 'active'
                ? 'warning'
                : 'neutral'
            }
          >
            {source.deleted ? 'Removed at source' : source.connectionStatus}
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
    <aside className="order-inspector" aria-label="Order details">
      <OrderActions
        detail={detail}
        organizationId={organizationId}
        here={here}
      />
      <InspectorCard title="Issues">
        <OrderIssues issues={detail.issues} organizationId={organizationId} />
      </InspectorCard>
      <InspectorCard title="Workflow runs">
        <WorkflowRuns runs={detail.workflows} organizationId={organizationId} />
      </InspectorCard>
      <InspectorCard title="Sources">
        <OrderSources sources={detail.sources} />
      </InspectorCard>
      <Disclosure>
        <summary>Luma identity</summary>
        <p className="order-note">
          Luma ID <code>{detail.order.id}</code>. Sources are linked only
          through confirmed source IDs, never by matching numbers or SKU text.
        </p>
      </Disclosure>
    </aside>
  );
}
