import './records.css';

import {
  type RecordKind,
  recordKindSchema,
  type RecordSummary,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  CollectionToolbar,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
import {
  DataTable,
  type DataTableColumn,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Plug } from 'lucide-react';
import { useState } from 'react';

import { connectionsOptions } from '../connections/data';
import { IdentityError } from '../identity/data';
import {
  recordListError,
  recordOptions,
  recordPageSize,
  recordReturnPath,
  recordsOptions,
} from './data';

const kinds: { value: string; kind: RecordKind | undefined; label: string }[] =
  [
    { value: 'all', kind: undefined, label: 'All records' },
    { value: 'order', kind: 'order', label: 'Orders' },
    { value: 'fulfillment', kind: 'fulfillment', label: 'Fulfillments' },
    { value: 'position', kind: 'position', label: 'Stock' },
    { value: 'sku', kind: 'sku', label: 'SKUs' },
    { value: 'product', kind: 'product', label: 'Products' },
    { value: 'issue', kind: 'issue', label: 'Issues' },
  ];

/**
 * Offers connected sources when there is more than one to choose from. An applied source always
 * keeps an option so its chip names it, even when it is no longer listed.
 */
function sourceOptions(
  connections: readonly { id: string; label: string }[] | undefined,
  applied: string | undefined,
) {
  const options = (
    connections && (connections.length > 1 || applied) ? connections : []
  ).map((item) => ({ value: item.id, label: item.label }));
  if (applied && !options.some((option) => option.value === applied))
    options.push({ value: applied, label: `Source ${applied.slice(0, 8)}` });

  return options;
}

function recordHref(
  organizationId: string,
  kind: RecordKind,
  id: string,
  search: {
    q: string;
    kind?: RecordKind | undefined;
    connectionId?: string | undefined;
    from?: string | undefined;
    cursor?: string | undefined;
    page?: number | undefined;
  },
) {
  const params = new URLSearchParams();
  if (search.q) params.set('q', search.q);
  if (search.kind) params.set('kind', search.kind);
  if (search.connectionId) params.set('connectionId', search.connectionId);
  if (search.from) params.set('from', search.from);
  if (search.cursor) params.set('cursor', search.cursor);
  if (search.page) params.set('page', String(search.page));

  return `/app/${encodeURIComponent(organizationId)}/records/${kind}/${id}${params.size ? `?${params}` : ''}`;
}

function recordColumns(
  href: (record: RecordSummary) => string,
): DataTableColumn<RecordSummary>[] {
  return [
    {
      key: 'kind',
      header: 'Type',
      cell: (record) => (
        <span className="record-row-kind">{record.kind.replace('_', ' ')}</span>
      ),
    },
    {
      key: 'record',
      header: 'Record',
      cell: (record) => (
        <span className="record-row-main">
          <DataTableRowLink href={href(record)}>
            {record.label}
          </DataTableRowLink>
          <small>{record.description}</small>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      hideOnNarrow: true,
      cell: (record) => (
        <span className="record-row-status">{record.status}</span>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      hideOnNarrow: true,
      cell: (record) => (
        <span className="record-row-source">
          <Badge
            tone={
              record.sources.some((source) => source.status !== 'active')
                ? 'warning'
                : 'neutral'
            }
          >
            {record.sources.length
              ? record.sources.length === 1
                ? record.sources[0]?.label
                : `${record.sources.length} sources`
              : 'Luma'}
          </Badge>
          {record.observedAt ? (
            <small>
              Observed <WorkspaceDate value={record.observedAt} />
            </small>
          ) : null}
        </span>
      ),
    },
  ];
}

/**
 * Searches current commerce and issue records with URL-backed filters and pages through results
 * with the API cursor, keeping a previous-page trail per search.
 */
export function RecordsPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/records/',
  });
  const search = useSearch({ from: '/app/$organizationId/records/' });
  const navigate = useNavigate({ from: '/app/$organizationId/records/' });
  const query = useQuery(recordsOptions(organizationId, search));
  const [trails, setTrails] = useState<Record<string, (string | undefined)[]>>(
    {},
  );
  const connections = useQuery(connectionsOptions(organizationId));
  // `from` is the page to return to from a record, not a filter; navigation keeps it.
  const listSearch = {
    q: search.q,
    kind: search.kind,
    connectionId: search.connectionId,
    from: search.from,
  };
  const filterKey = JSON.stringify(listSearch);
  const trail = trails[filterKey] ?? [undefined];
  const position = trail.indexOf(search.cursor);
  const error = recordListError(query.error, search);
  const goTo = (cursor: string | undefined, page: number | undefined) =>
    void navigate({ search: { ...listSearch, cursor, page } });
  const nextCursor = query.data?.nextCursor;

  return (
    <main className="records-page records-list">
      <PageHeader
        title="Records"
        description="Follow the source facts behind orders, stock, fulfillments and issues."
      />
      <CollectionToolbar
        views={
          <CollectionViews
            label="Record types"
            value={search.kind ?? 'all'}
            views={kinds}
            onChange={(value) =>
              void navigate({
                search: {
                  ...listSearch,
                  kind: kinds.find((item) => item.value === value)?.kind,
                },
              })
            }
          />
        }
        search={{
          value: search.q || undefined,
          onChange: (q) =>
            void navigate({
              search: { ...listSearch, q: q?.trim() ?? '' },
            }),
          label: 'Search records',
          placeholder: 'Search number, source ID or record…',
          maxLength: 120,
        }}
        filters={[
          {
            kind: 'choice',
            key: 'connectionId',
            label: 'Source',
            icon: Plug,
            value: search.connectionId,
            options: sourceOptions(connections.data, search.connectionId),
            onChange: (connectionId) =>
              void navigate({ search: { ...listSearch, connectionId } }),
          },
        ]}
        onClear={() =>
          void navigate({
            search: { q: '', kind: search.kind, from: search.from },
          })
        }
        onRefresh={() => void query.refetch()}
        refreshing={query.isFetching}
        refreshLabel="Refresh records"
      />
      <p className="record-coverage">
        Customer and return records appear once connected sources share them.{' '}
        {recordPageSize} records per page, most recently observed first.
      </p>
      {query.isPending ? (
        <p className="record-notice" role="status">
          Loading records…
        </p>
      ) : query.isPaused ? (
        <p className="record-notice" role="status">
          Disconnected. Reconnect to load records.
        </p>
      ) : error?.kind === 'access' ? (
        <p className="record-notice" role="alert">
          You no longer have access to this workspace.
        </p>
      ) : error?.kind === 'page' ? (
        <Alert role="alert">
          {error.message ??
            'This page link no longer matches the record search.'}{' '}
          <Button variant="outline" onClick={() => goTo(undefined, undefined)}>
            Go to the first page
          </Button>
        </Alert>
      ) : query.isError ? (
        <p className="record-notice" role="alert">
          Records are unavailable. Try refreshing.
        </p>
      ) : (
        <>
          <DataTable
            caption="Matching records"
            columns={recordColumns((record) =>
              recordHref(organizationId, record.kind, record.id, search),
            )}
            rows={query.data.items}
            rowKey={(record) => `${record.kind}:${record.id}`}
            rowHeader="record"
            empty={
              <p className="record-notice">
                No records match this search. Source coverage may still be
                incomplete.
              </p>
            }
          />
          {query.data.items.length || search.cursor ? (
            <Pagination
              count={query.data.items.length}
              page={search.page ?? 1}
              pageSize={recordPageSize}
              hasNext={!!nextCursor}
              onPrevious={
                position > 0
                  ? () =>
                      goTo(
                        trail[position - 1],
                        Math.max(1, (search.page ?? 1) - 1),
                      )
                  : undefined
              }
              onNext={() => {
                if (!nextCursor) return;
                if (position >= 0)
                  setTrails((previous) => ({
                    ...previous,
                    [filterKey]: [...trail.slice(0, position + 1), nextCursor],
                  }));
                goTo(nextCursor, (search.page ?? 1) + 1);
              }}
              disabled={query.isFetching}
              itemLabel="records"
              label="Record pages"
            />
          ) : null}
          {search.cursor && position < 0 ? (
            <Button variant="ghost" onClick={() => goTo(undefined, undefined)}>
              Return to first page
            </Button>
          ) : null}
        </>
      )}
    </main>
  );
}

function formatField(key: string) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function RecordLines({
  lines,
  organizationId,
  search,
}: {
  lines: unknown;
  organizationId: string;
  search: {
    q: string;
    kind?: RecordKind | undefined;
    connectionId?: string | undefined;
    from?: string | undefined;
  };
}) {
  if (!Array.isArray(lines) || !lines.length) return null;

  return (
    <div className="record-lines">
      <h3>Lines</h3>
      <ul>
        {lines.map((value, index) => {
          if (!value || typeof value !== 'object') return null;
          const line = value as Record<string, unknown>;
          const skuId = typeof line.skuId === 'string' ? line.skuId : null;
          const lineId =
            typeof line.id === 'string'
              ? line.id
              : typeof line.orderLineId === 'string'
                ? line.orderLineId
                : null;

          return (
            <li key={lineId ?? index}>
              <span>
                {skuId ? (
                  <a href={recordHref(organizationId, 'sku', skuId, search)}>
                    SKU {skuId.slice(0, 8)}{' '}
                    <ArrowRight size={12} aria-hidden="true" />
                  </a>
                ) : (
                  `Line ${lineId?.slice(0, 8) ?? index + 1}`
                )}
              </span>
              <span>
                {String(line.quantity ?? 'Unknown')} {String(line.unit ?? '')}
                {line.cancelledQuantity
                  ? ` · ${line.cancelledQuantity} cancelled`
                  : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Shows each source snapshot and confirmed relationships for one shareable record. */
export function RecordDetailPage() {
  const { organizationId, kind, recordId } = useParams({
    from: '/app/$organizationId/records/$kind/$recordId',
  });
  const search = useSearch({
    from: '/app/$organizationId/records/$kind/$recordId',
  });
  const parsed = recordKindSchema.safeParse(kind);
  const query = useQuery({
    ...recordOptions(
      organizationId,
      parsed.success ? parsed.data : 'order',
      recordId,
    ),
    enabled: parsed.success,
  });
  const returnPath = recordReturnPath(organizationId, search.from);
  const listSearch = {
    q: search.q,
    kind: search.kind,
    connectionId: search.connectionId,
    cursor: search.cursor,
    page: search.page ? String(search.page) : undefined,
  };
  const listParams = new URLSearchParams(
    Object.entries(listSearch).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const back =
    returnPath ??
    `/app/${encodeURIComponent(organizationId)}/records${listParams.size ? `?${listParams}` : ''}`;
  const record = query.data?.record;
  const denied =
    query.error instanceof IdentityError &&
    [401, 403].includes(query.error.status);

  return (
    <main className="records-page record-detail-page">
      <a className="record-back" href={back}>
        <ArrowLeft size={16} />{' '}
        {returnPath ? 'Back to context' : 'Back to records'}
      </a>
      {!parsed.success ? (
        <p className="record-notice">Record type unavailable.</p>
      ) : query.isPending ? (
        <p className="record-notice" role="status">
          Loading record…
        </p>
      ) : query.isPaused ? (
        <p className="record-notice">
          Disconnected. Reconnect to inspect this record.
        </p>
      ) : denied ? (
        <p className="record-notice" role="alert">
          You no longer have access to this workspace.
        </p>
      ) : query.isError ? (
        <p className="record-notice" role="alert">
          Record unavailable or removed.
        </p>
      ) : record ? (
        <>
          <header className="record-detail-head">
            <div>
              <p className="record-eyebrow">
                {record.kind.replace('_', ' ')} / {record.id}
              </p>
              <h1>{record.label}</h1>
              <p>{record.description}</p>
            </div>
            <Badge
              tone={record.coverage === 'projected' ? 'neutral' : 'warning'}
            >
              {record.coverage === 'projected'
                ? record.status
                : 'Source identity only'}
            </Badge>
          </header>
          <div className="record-detail-grid">
            <section className="record-card">
              <h2>Source facts</h2>
              <p className="record-note">
                Records from different sources stay separate when their details
                differ. A shared identity does not confirm every field matches.
              </p>
              {query.data.snapshots.length ? (
                query.data.snapshots.map((snapshot, index) => (
                  <div
                    className="record-snapshot"
                    key={`${snapshot.connectionId}:${index}`}
                  >
                    <div className="record-snapshot-head">
                      <strong>
                        {record.sources.find(
                          (source) =>
                            source.connectionId === snapshot.connectionId,
                        )?.label ?? 'Connected source'}
                      </strong>
                      <span>
                        Observed <WorkspaceDate value={snapshot.observedAt} />
                      </span>
                    </div>
                    <dl>
                      {Object.entries(snapshot.data)
                        .filter(
                          ([, value]) =>
                            !Array.isArray(value) &&
                            (typeof value !== 'object' || value === null),
                        )
                        .map(([key, value]) => (
                          <div key={key}>
                            <dt>{formatField(key)}</dt>
                            <dd>
                              {value === null ? (
                                'Unknown'
                              ) : typeof value === 'string' &&
                                key.endsWith('At') &&
                                !Number.isNaN(Date.parse(value)) ? (
                                <WorkspaceDate value={value} />
                              ) : (
                                String(value)
                              )}
                            </dd>
                          </div>
                        ))}
                    </dl>
                    <RecordLines
                      lines={snapshot.data.lines}
                      organizationId={organizationId}
                      search={search}
                    />
                  </div>
                ))
              ) : (
                <p className="record-note">
                  Source identity is known. No current projected facts are
                  available.
                </p>
              )}
            </section>
            <aside className="record-detail-side">
              <section className="record-card">
                <h2>Sources</h2>
                {record.sources.length ? (
                  record.sources.map((source, index) => (
                    <div
                      className="record-source"
                      key={`${source.connectionId}:${index}`}
                    >
                      <strong>{source.label}</strong>
                      <Badge
                        tone={
                          source.status === 'active' ? 'neutral' : 'warning'
                        }
                      >
                        {source.status}
                      </Badge>
                      {source.externalId ? (
                        <small>Source ID {source.externalId}</small>
                      ) : null}
                      <small>
                        {source.mappingMethod
                          ? `Mapping: ${source.mappingMethod}`
                          : 'Mapping: derived from linked source identities'}
                      </small>
                      <small>
                        Source updated{' '}
                        {source.sourceUpdatedAt ? (
                          <WorkspaceDate value={source.sourceUpdatedAt} />
                        ) : (
                          'unknown'
                        )}
                      </small>
                      <small>
                        Observed{' '}
                        {source.observedAt ? (
                          <WorkspaceDate value={source.observedAt} />
                        ) : (
                          'unknown'
                        )}
                      </small>
                    </div>
                  ))
                ) : (
                  <p className="record-note">
                    Luma issue record. No commerce source mapping.
                  </p>
                )}
              </section>
              <section className="record-card">
                <h2>Related records</h2>
                {query.data.links.length ? (
                  <ul className="record-related">
                    {query.data.links.map((link) => (
                      <li key={`${link.kind}:${link.id}`}>
                        <a
                          href={recordHref(
                            organizationId,
                            link.kind,
                            link.id,
                            search,
                          )}
                        >
                          <span>
                            <small>{link.relationship}</small>
                            <strong>
                              {link.label} · {link.id.slice(0, 8)}
                            </strong>
                          </span>
                          <ArrowRight size={15} />
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="record-note">
                    No confirmed related records yet.
                  </p>
                )}
                {record.kind === 'issue' ? (
                  <Link
                    to="/app/$organizationId/exceptions/$exceptionId"
                    params={{ organizationId, exceptionId: record.id }}
                    search={{ view: 'needs_you' }}
                    className="record-action"
                  >
                    Investigate issue <ArrowRight size={14} />
                  </Link>
                ) : record.kind === 'position' ? (
                  <Link
                    to="/app/$organizationId/inventory/$positionId"
                    params={{ organizationId, positionId: record.id }}
                    className="record-action"
                  >
                    Inspect stock <ArrowRight size={14} />
                  </Link>
                ) : record.kind === 'sku' ? (
                  <>
                    <Link
                      to="/app/$organizationId/products/$skuId"
                      params={{ organizationId, skuId: record.id }}
                      className="record-action"
                    >
                      Open in Products <ArrowRight size={14} />
                    </Link>
                    <Link
                      to="/app/$organizationId/inventory"
                      params={{ organizationId }}
                      search={{ skuId: record.id }}
                      className="record-action"
                    >
                      View inventory <ArrowRight size={14} />
                    </Link>
                  </>
                ) : record.kind === 'order' ? (
                  <Link
                    to="/app/$organizationId/orders/$orderId"
                    params={{ organizationId, orderId: record.id }}
                    className="record-action"
                  >
                    Open in Orders <ArrowRight size={14} />
                  </Link>
                ) : record.kind === 'fulfillment' ? (
                  <Link
                    to="/app/$organizationId/fulfillment/$fulfillmentId"
                    params={{ organizationId, fulfillmentId: record.id }}
                    className="record-action"
                  >
                    Open in Fulfillment <ArrowRight size={14} />
                  </Link>
                ) : null}
              </section>
            </aside>
          </div>
        </>
      ) : null}
    </main>
  );
}
