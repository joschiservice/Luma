import './records.css';

import {
  type RecordKind,
  recordKindSchema,
  type RecordSummary,
} from '@luma/api-contract';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';

import { IdentityError } from '../identity/data';
import { recordOptions, recordReturnPath, recordsOptions } from './data';

const kinds: { value: RecordKind | ''; label: string }[] = [
  { value: '', label: 'All records' },
  { value: 'order', label: 'Orders' },
  { value: 'fulfillment', label: 'Fulfillments' },
  { value: 'position', label: 'Stock' },
  { value: 'sku', label: 'SKUs' },
  { value: 'product', label: 'Products' },
  { value: 'issue', label: 'Issues' },
];

function recordHref(
  organizationId: string,
  kind: RecordKind,
  id: string,
  search: {
    q: string;
    kind?: RecordKind | undefined;
    connectionId?: string | undefined;
    from?: string | undefined;
  },
) {
  const params = new URLSearchParams();
  if (search.q) params.set('q', search.q);
  if (search.kind) params.set('kind', search.kind);
  if (search.connectionId) params.set('connectionId', search.connectionId);
  if (search.from) params.set('from', search.from);

  return `/app/${encodeURIComponent(organizationId)}/records/${kind}/${id}${params.size ? `?${params}` : ''}`;
}

function RecordRow({ record, href }: { record: RecordSummary; href: string }) {
  return (
    <li>
      <a className="record-row" href={href}>
        <span className="record-row-kind">{record.kind.replace('_', ' ')}</span>
        <span className="record-row-main">
          <strong>{record.label}</strong>
          <small>{record.description}</small>
        </span>
        <span className="record-row-status">{record.status}</span>
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
        <ArrowRight size={16} aria-hidden="true" />
      </a>
    </li>
  );
}

/** Searches current commerce and issue records with URL-backed filters. */
export function RecordsPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/records/',
  });
  const search = useSearch({ from: '/app/$organizationId/records/' });
  const navigate = useNavigate({ from: '/app/$organizationId/records/' });
  const [draft, setDraft] = useState(search.q);
  const query = useQuery(
    recordsOptions(organizationId, {
      q: search.q,
      kind: search.kind,
      connectionId: search.connectionId,
    }),
  );
  const denied =
    query.error instanceof IdentityError &&
    [401, 403, 404].includes(query.error.status);

  return (
    <main className="records-page">
      <PageHeader
        title="Records"
        description="Follow the source facts behind orders, stock, fulfillments and issues."
      />
      <div className="record-explorer-head">
        <form
          className="record-search"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate({
              search: {
                q: draft.trim(),
                kind: search.kind,
                connectionId: search.connectionId,
                from: search.from,
              },
            });
          }}
        >
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="Search records"
            placeholder="Search number, source ID or record…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={120}
          />
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>
        <Button
          variant="outline"
          aria-label="Refresh records"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={16} /> Refresh
        </Button>
      </div>
      <nav className="record-filters" aria-label="Record types">
        {kinds.map(({ value, label }) => (
          <button
            type="button"
            key={label}
            className={search.kind === (value || undefined) ? 'active' : ''}
            aria-current={
              search.kind === (value || undefined) ? 'page' : undefined
            }
            onClick={() =>
              void navigate({
                search: {
                  q: search.q,
                  kind: value || undefined,
                  connectionId: search.connectionId,
                  from: search.from,
                },
              })
            }
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="record-coverage">
        <Badge tone="neutral">Current records</Badge>
        {search.connectionId ? (
          <Badge tone="neutral">One connected source</Badge>
        ) : null}
        <span>
          Customer and return records are waiting for connected source
          projections. Search results show up to 50 matches.
        </span>
      </div>
      {query.isPending ? (
        <p className="record-notice" role="status">
          Loading records…
        </p>
      ) : query.isPaused ? (
        <p className="record-notice" role="status">
          Disconnected. Reconnect to load records.
        </p>
      ) : denied ? (
        <p className="record-notice" role="alert">
          You no longer have access to this workspace.
        </p>
      ) : query.isError ? (
        <p className="record-notice" role="alert">
          Records are unavailable. Try refreshing.
        </p>
      ) : !query.data?.items.length ? (
        <p className="record-notice">
          No records match this search. Source coverage may still be incomplete.
        </p>
      ) : (
        <ul className="record-list">
          {query.data.items.map((record) => (
            <RecordRow
              key={`${record.kind}:${record.id}`}
              record={record}
              href={recordHref(organizationId, record.kind, record.id, search)}
            />
          ))}
        </ul>
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
                ) : record.kind === 'order' ? (
                  <Link
                    to="/app/$organizationId/orders/$orderId"
                    params={{ organizationId, orderId: record.id }}
                    className="record-action"
                  >
                    Open in Orders <ArrowRight size={14} />
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
