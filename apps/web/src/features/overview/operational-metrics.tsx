import './operational-metrics.css';

import type {
  OperationalMetricRequest,
  OperationalMetricResponse,
} from '@luma/api-contract';
import {
  CaseLoading,
  CaseNotice,
} from '@luma/ui/components/issues/case-investigation';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import {
  ArrowUpRight,
  Boxes,
  CircleAlert,
  ClipboardList,
  Plug,
  RefreshCw,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { IdentityError } from '../identity/data';
import { useLiveMetricQuery } from './metrics-live';
import {
  operationalMetricRequest,
  operationalMetricsOptions,
} from './operational-metrics-data';
import { ResolutionEvidence } from './resolution-evidence';

const defaultConfig = {
  initial: operationalMetricRequest,
  key: 'operational-metrics',
  options: operationalMetricsOptions,
};

type Metric = OperationalMetricResponse['metrics'][number];

type Item = Metric['items'][number];

const groups = [
  {
    id: 'cases',
    title: 'Issues',
    subtitle: 'Intervention & workload',
    icon: CircleAlert,
  },
  {
    id: 'inventory',
    title: 'Monitored stock',
    subtitle: 'Active replenishment rules',
    icon: Boxes,
  },
  {
    id: 'procurement',
    title: 'Procurement',
    subtitle: 'Recorded purchase orders',
    icon: ClipboardList,
  },
  {
    id: 'connections',
    title: 'Connections',
    subtitle: 'Health & observation freshness',
    icon: Plug,
  },
];
const reasonLabels: Record<string, string> = {
  eligible: 'Eligible',
  unknown_eligibility: 'Unknown eligibility',
  unknown_attribution: 'Unknown attribution',
  unknown_environment: 'Unknown environment · excluded',
  approval: 'Approval',
  manual_intervention: 'Manual intervention',
  uncertainty: 'Uncertainty',
  existing_commitment: 'Existing commitment',
  no_commitment: 'No commitment',
  missing: 'Missing stock',
  deleted: 'Deleted stock',
  nonnumeric: 'Invalid quantity',
  future: 'Future observation',
  expired: 'Expired observation',
  invalid_time: 'Invalid observation time',
  pending: 'Pending',
  degraded: 'Degraded',
  revoked: 'Revoked',
  stale: 'Stale reads',
  unobserved: 'Unobserved reads',
};

/** Groups current operational priorities and opens their authorized matching records. */
export function OperationalMetrics({
  organizationId,
  initialRequest,
  heading = 'Your operational pulse',
  description = 'Find the work that needs your next move.',
  metricGroups = groups,
}: {
  organizationId: string;
  initialRequest?: OperationalMetricRequest;
  heading?: string;
  description?: string;
  metricGroups?: {
    id: string;
    title: string;
    subtitle: string;
    icon: typeof CircleAlert;
    metrics?: string[];
  }[];
}) {
  const config = useMemo(
    () =>
      initialRequest
        ? {
            initial: initialRequest,
            key: 'resolution-metrics',
            options: operationalMetricsOptions,
          }
        : defaultConfig,
    [initialRequest],
  );
  const { query, request, setRequest, connection } = useLiveMetricQuery<
    OperationalMetricRequest,
    OperationalMetricResponse
  >(organizationId, config);
  const [selected, setSelected] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const unavailable =
    query.isError ||
    query.isPaused ||
    connection === 'denied' ||
    connection === 'offline';
  const data = unavailable ? undefined : query.data;
  const metric = data?.metrics.find((m) => m.definition.id === selected);
  const conflict =
    query.error instanceof IdentityError && query.error.status === 409;
  const refresh = () => {
    if (request.snapshot) setRequest(config.initial);
    else void query.refetch();
  };

  return (
    <section className="operational-metrics" aria-label={heading}>
      <header className="operational-heading">
        <div>
          <p className="order-metrics-eyebrow">
            {initialRequest ? 'Detection cohort' : 'Right now'}
          </p>
          <h2>{heading}</h2>
          <p>{description}</p>
        </div>
        <div className="operational-status">
          <Badge tone={connection === 'live' ? 'neutral' : 'warning'}>
            {connection === 'denied'
              ? 'Access changed'
              : connection === 'offline'
                ? 'Offline'
                : query.isError
                  ? 'Updates unavailable'
                  : connection === 'live'
                    ? 'Live updates'
                    : connection === 'syncing'
                      ? 'Updating'
                      : 'Connecting'}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={
              query.isFetching ||
              query.isPaused ||
              connection === 'denied' ||
              connection === 'offline'
            }
          >
            <RefreshCw size={14} />
            Refresh summary
          </Button>
        </div>
      </header>
      {unavailable ? (
        <CaseNotice
          error
          title={
            connection === 'denied'
              ? 'Workspace access changed'
              : conflict
                ? 'The matching records changed'
                : 'Summary unavailable'
          }
        >
          {connection === 'denied'
            ? 'Sign in again to continue.'
            : connection === 'offline'
              ? 'Reconnect to load current metrics.'
              : 'Refresh the summary to load current records.'}
        </CaseNotice>
      ) : query.isPending ? (
        <CaseLoading />
      ) : data ? (
        <>
          <div className="operational-groups">
            {metricGroups.map((group) => {
              const Icon = group.icon;

              return (
                <Card as="div" className="operational-group" key={group.id}>
                  <header>
                    <Icon size={17} aria-hidden="true" />
                    <div>
                      <h3>{group.title}</h3>
                      <p>{group.subtitle}</p>
                    </div>
                  </header>
                  <div>
                    {data.metrics
                      .filter((m) =>
                        group.metrics
                          ? group.metrics.includes(m.definition.id)
                          : m.definition.family === group.id,
                      )
                      .map((m) => (
                        <button
                          type="button"
                          className="operational-row"
                          key={m.definition.id}
                          data-metric={m.definition.id}
                          onClick={(event) => {
                            trigger.current = event.currentTarget;
                            setSelected(m.definition.id);
                            if (request.snapshot) setRequest(config.initial);
                          }}
                        >
                          <span className="operational-label">
                            {m.definition.title}
                            <small>{metricHint(m)}</small>
                          </span>
                          <strong className="operational-value">
                            {metricValue(m)}
                          </strong>
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </button>
                      ))}
                  </div>
                </Card>
              );
            })}
          </div>
          <p className="operational-footnote">
            Evaluated <WorkspaceDate value={data.asOf} /> · Select a metric to
            inspect its definition and matching records.
          </p>
        </>
      ) : null}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            if (request.snapshot) setRequest(config.initial);
          }
        }}
      >
        <DialogContent className="operational-dialog" finalFocus={trigger}>
          <DialogHeader>
            <DialogTitle>
              {metric?.definition.title ?? 'Operational records'}
            </DialogTitle>
            <DialogDescription>
              Matching records from one snapshot. Live changes return this list
              to the first page.
            </DialogDescription>
          </DialogHeader>
          {metric && data ? (
            <>
              <div className="order-cohort-definition">
                <Badge tone="neutral">
                  {metric.coverage === 'complete'
                    ? 'Complete within scope'
                    : metric.coverage === 'partial'
                      ? 'Partial coverage'
                      : 'No monitored population'}
                </Badge>
                <p>{metric.definition.description}</p>
                <p>{metric.definition.timeSemantics}</p>
              </div>
              <dl className="order-cohort-facts">
                <div>
                  <dt>
                    {metric.definition.id === 'resolution.time_to_outcome'
                      ? 'Median verified duration'
                      : metric.definition.unit === 'second'
                        ? 'Age since first detection'
                        : 'Known matches'}
                  </dt>
                  <dd>{metricValue(metric)}</dd>
                </div>
                <div>
                  <dt>Unknown classification</dt>
                  <dd>{metric.unknownCount}</dd>
                </div>
                <div>
                  <dt>Population in scope</dt>
                  <dd>{metric.population}</dd>
                </div>
              </dl>
              {metric.breakdown.length ? (
                <div
                  className="operational-breakdown"
                  aria-label="Reason breakdown"
                >
                  {metric.breakdown.map((b) => (
                    <Badge
                      key={b.reason}
                      tone={b.count ? 'warning' : 'neutral'}
                    >
                      {reasonLabels[b.reason] ?? b.reason} · {b.count}
                    </Badge>
                  ))}
                </div>
              ) : null}
              <p className="order-cohort-note">{metric.coverageExplanation}</p>
              {metric.definition.family === 'resolution' ? (
                <p className="order-cohort-note">
                  Data-through time:{' '}
                  {metric.dataThrough ? (
                    <WorkspaceDate value={metric.dataThrough} />
                  ) : (
                    'Unknown. No complete provider scan watermark.'
                  )}
                </p>
              ) : null}
              {metric.items.length ? (
                <ul
                  className="operational-cohort"
                  aria-label="Matching records"
                >
                  {metric.items.map((item) => (
                    <li key={item.id}>
                      <CohortItem item={item} organizationId={organizationId} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="order-cohort-empty">
                  <ClipboardList size={26} />
                  <strong>
                    {metric.population === 0 &&
                    metric.definition.family === 'inventory'
                      ? 'No active stock rules'
                      : metric.definition.unit === 'second' &&
                          metric.unknownCount
                        ? 'Detection time unavailable'
                        : 'No matching records'}
                  </strong>
                  <p>
                    {metric.unknownCount
                      ? 'Unknown records prevent a complete total.'
                      : metric.coverage === 'unavailable'
                        ? metric.definition.family === 'resolution'
                          ? 'No classified incidents in this environment and detection window. Check unknown environment or choose another cohort.'
                          : 'Add a replenishment rule to monitor a stock position.'
                        : 'This cohort is empty at the evaluation time.'}
                  </p>
                </div>
              )}
              <div className="order-cohort-pagination">
                <span>
                  {metric.observedCount
                    ? `${Math.min(data.offset + 1, metric.observedCount)}–${Math.min(data.offset + metric.items.length, metric.observedCount)} of ${metric.observedCount}`
                    : '0 matching records'}{' '}
                  · <WorkspaceDate value={data.asOf} />
                </span>
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!data.offset || query.isFetching}
                    onClick={() =>
                      setRequest({
                        ...config.initial,
                        asOf: data.asOf,
                        snapshot: data.snapshot,
                        offset: Math.max(0, data.offset - data.limit),
                      })
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      data.offset + data.limit >= metric.observedCount ||
                      data.offset + data.limit > 10000 ||
                      query.isFetching
                    }
                    onClick={() =>
                      setRequest({
                        ...config.initial,
                        asOf: data.asOf,
                        snapshot: data.snapshot,
                        offset: data.offset + data.limit,
                      })
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          ) : query.isPending ? (
            <CaseLoading />
          ) : (
            <CaseNotice
              error
              title={
                conflict
                  ? 'The matching records changed'
                  : 'Records unavailable'
              }
            >
              Refresh to load current records.{' '}
              <Button variant="outline" onClick={refresh}>
                Refresh summary
              </Button>
            </CaseNotice>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function metricValue(metric: Metric) {
  if (
    metric.definition.id === 'resolution.autonomous' &&
    metric.total === null &&
    metric.coverage !== 'unavailable'
  )
    return `${metric.observedCount} known`;
  if (metric.definition.unit === 'second')
    return metric.value === null ? '—' : age(metric.value);

  return metric.coverage === 'unavailable'
    ? '—'
    : (metric.value?.toLocaleString() ?? '—');
}

function metricHint(metric: Metric) {
  if (metric.definition.family === 'resolution')
    return metric.coverage === 'unavailable'
      ? 'No classified cohort'
      : metric.unknownCount
        ? `${metric.unknownCount} unknown · partial coverage`
        : metric.definition.id === 'resolution.autonomous'
          ? 'Eligible · verified · complete attribution'
          : 'Each incident counted once';
  if (metric.definition.unit === 'second')
    return metric.unknownCount
      ? 'Unknown detection times'
      : 'Since first detection';
  if (metric.definition.family === 'inventory') {
    if (!metric.population) return 'No active rules';
    if (metric.definition.id === 'inventory.below_minimum')
      return `${metric.breakdown.find((b) => b.reason === 'no_commitment')?.count ?? 0} without a commitment${metric.unknownCount ? ` · ${metric.unknownCount} unknown` : ''}`;

    return 'Configured source · five-minute freshness';
  }
  if (metric.definition.id === 'cases.attention')
    return (
      metric.breakdown
        .filter((b) => b.count)
        .map((b) => `${b.count} ${reasonLabels[b.reason]?.toLowerCase()}`)
        .join(' · ') || 'No intervention requested'
    );
  if (metric.definition.family === 'procurement')
    return metric.definition.id.endsWith('.draft')
      ? 'Awaiting the next step'
      : 'Recorded operational commitments';

  return metric.definition.family === 'connections'
    ? 'Each connection counted once'
    : 'Across all subject kinds';
}

function age(seconds: number) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;

  return `${Math.floor(seconds / 86400)}d`;
}

function CohortItem({
  item,
  organizationId,
}: {
  item: Item;
  organizationId: string;
}) {
  if (item.kind === 'resolution')
    return (
      <div className="resolution-cohort-item">
        <Link
          to="/app/$organizationId/exceptions/$exceptionId"
          params={{ organizationId, exceptionId: item.id }}
          search={{ view: item.outcome === 'verified' ? 'history' : 'active' }}
        >
          {item.title.replaceAll('_', ' ')} <ArrowUpRight size={13} />
        </Link>
        <span>
          <Badge tone={item.involvement === 'unknown' ? 'warning' : 'neutral'}>
            {item.involvement === 'none'
              ? 'Complete attribution · no human work'
              : item.involvement === 'human'
                ? 'Human involvement recorded'
                : 'Attribution unknown'}
          </Badge>{' '}
          <Badge tone="neutral">{item.eligibility}</Badge>
        </span>
        <small>
          First detected <WorkspaceDate value={item.detectedAt} /> ·{' '}
          {item.verifiedAt ? (
            <>
              Verified <WorkspaceDate value={item.verifiedAt} />
            </>
          ) : (
            'Awaiting independent verification'
          )}
        </small>
        <ResolutionEvidence organizationId={organizationId} item={item} />
      </div>
    );
  if (item.kind === 'case')
    return (
      <>
        <div>
          <Link
            to="/app/$organizationId/exceptions/$exceptionId"
            params={{ organizationId, exceptionId: item.id }}
            search={{ view: 'active' }}
          >
            {item.title.replaceAll('_', ' ')}
            <ArrowUpRight size={13} />
          </Link>
          <span>
            {item.subjectKind.replaceAll('_', ' ')} · {item.subjectId}
          </span>
          <small>
            {item.detectedAt && item.ageSeconds !== null ? (
              <>
                First detected <WorkspaceDate value={item.detectedAt} /> ·{' '}
                {age(item.ageSeconds)} ago
              </>
            ) : (
              'Detection time unknown'
            )}
          </small>
        </div>
        <Badge tone={item.reason ? 'warning' : 'neutral'}>
          {item.reason
            ? reasonLabels[item.reason]
            : item.state.replaceAll('_', ' ')}
        </Badge>
      </>
    );
  if (item.kind === 'purchase_order')
    return (
      <>
        <div>
          <Link
            to="/app/$organizationId/procurement/$purchaseOrderId"
            params={{ organizationId, purchaseOrderId: item.id }}
          >
            {item.reference}
            <ArrowUpRight size={13} />
          </Link>
          <span>
            {item.supplierName} ·{' '}
            {item.authority === 'luma' ? 'Luma-managed' : 'External authority'}
          </span>
          <small>
            Created <WorkspaceDate value={item.createdAt} />
            {item.ageSeconds !== null ? ` · ${age(item.ageSeconds)} ago` : ''}
          </small>
        </div>
        <Badge tone="neutral">{item.status}</Badge>
      </>
    );
  if (item.kind === 'connection')
    return (
      <>
        <div>
          <ConnectionLink id={item.id} organizationId={organizationId}>
            {item.label}
          </ConnectionLink>
          <small>
            {item.lastObservedAt ? (
              <>
                Last observed <WorkspaceDate value={item.lastObservedAt} />
              </>
            ) : (
              'No permitted read observations'
            )}
          </small>
        </div>
        <div className="operational-breakdown">
          {item.reasons.map((reason) => (
            <Badge key={reason} tone="warning">
              {reasonLabels[reason] ?? reason}
            </Badge>
          ))}
        </div>
      </>
    );

  return (
    <>
      <div>
        <strong>{item.sku}</strong>
        <span>
          {item.reason
            ? reasonLabels[item.reason]
            : `${item.available} ${item.unit ?? ''} available · minimum ${item.minimum}`}
        </span>
        <small>Position {item.id.slice(0, 8)}</small>
        <div className="operational-links">
          <Link
            to="/app/$organizationId/inventory/$positionId"
            params={{ organizationId, positionId: item.id }}
          >
            Inspect stock
            <ArrowUpRight size={12} />
          </Link>
          <Link
            to="/app/$organizationId/workflows/$definitionId"
            params={{ organizationId, definitionId: 'inventory-replenishment' }}
            hash={`rule-${item.ruleId}`}
          >
            Stock rule
            <ArrowUpRight size={12} />
          </Link>
          <ConnectionLink
            id={item.connectionId}
            organizationId={organizationId}
          >
            Configured connection
          </ConnectionLink>
        </div>
        {item.commitmentIds.map((id) => (
          <Link
            key={id}
            to="/app/$organizationId/procurement/$purchaseOrderId"
            params={{ organizationId, purchaseOrderId: id }}
          >
            Commitment {id.slice(0, 8)}
            <ArrowUpRight size={12} />
          </Link>
        ))}
      </div>
      <Badge
        tone={item.reason || !item.commitmentIds.length ? 'warning' : 'neutral'}
      >
        {item.reason
          ? 'Stock unknown'
          : item.commitmentIds.length
            ? 'Existing commitment'
            : 'No commitment'}
      </Badge>
    </>
  );
}

function ConnectionLink({
  id,
  organizationId,
  children,
}: {
  id: string;
  organizationId: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to="/app/$organizationId/apps"
      params={{ organizationId }}
      hash={`connection-${id}`}
    >
      {children}
      <ArrowUpRight size={12} />
    </Link>
  );
}
