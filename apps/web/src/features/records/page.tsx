import './records.css';

import {
  type RecordKind,
  recordKindSchema,
  type RecordSummary,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
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
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { quantityUnit } from '@luma/ui/lib/units';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ArrowRight, Database, Plug } from 'lucide-react';
import { useState } from 'react';

import { connectionsOptions } from '../connections/data';
import { IdentityError } from '../identity/data';
import { linkMethodLabel } from '../sync/presentation';
import {
  recordListError,
  recordOptions,
  recordPageSize,
  recordReturnPath,
  recordsOptions,
} from './data';

const kinds = (): {
  value: string;
  kind: RecordKind | undefined;
  label: string;
}[] => [
  { value: 'all', kind: undefined, label: m.records_kind_all() },
  { value: 'order', kind: 'order', label: m.records_kind_order_plural() },
  {
    value: 'fulfillment',
    kind: 'fulfillment',
    label: m.records_kind_fulfillment_plural(),
  },
  {
    value: 'position',
    kind: 'position',
    label: m.records_kind_position_plural(),
  },
  { value: 'sku', kind: 'sku', label: m.records_kind_sku_plural() },
  { value: 'product', kind: 'product', label: m.records_kind_product_plural() },
  { value: 'issue', kind: 'issue', label: m.records_kind_issue_plural() },
];

/** Singular name of each record type, as shown beside a record. */
const kindLabels = {
  order: m.records_kind_order,
  fulfillment: m.records_kind_fulfillment,
  position: m.records_kind_position,
  sku: m.records_kind_sku,
  product: m.records_kind_product,
  issue: m.records_kind_issue,
} satisfies Record<RecordKind, () => string>;

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
    options.push({
      value: applied,
      label: m.records_source_unknown({ id: applied.slice(0, 8) }),
    });

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
      header: m.records_column_type(),
      cell: (record) => (
        <span className="record-row-kind">{kindLabels[record.kind]()}</span>
      ),
    },
    {
      key: 'record',
      header: m.records_column_record(),
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
      header: m.common_status(),
      hideOnNarrow: true,
      cell: (record) => (
        <span className="record-row-status">{record.status}</span>
      ),
    },
    {
      key: 'source',
      header: m.common_source(),
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
                : m.records_source_count({ count: record.sources.length })
              : 'Luma'}
          </Badge>
          {record.observedAt ? (
            <small>
              {rich(m.records_last_read, {
                date: <WorkspaceDate value={record.observedAt} />,
              })}
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
  const views = kinds();

  return (
    <main className="records-page records-list">
      <PageTitle title={m.records_title()} />
      <CollectionToolbar
        views={
          <CollectionViews
            label={m.records_views()}
            value={search.kind ?? 'all'}
            views={views}
            onChange={(value) =>
              void navigate({
                search: {
                  ...listSearch,
                  kind: views.find((item) => item.value === value)?.kind,
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
          label: m.records_search(),
          placeholder: m.records_search_placeholder(),
          maxLength: 120,
        }}
        filters={[
          {
            kind: 'choice',
            key: 'connectionId',
            label: m.common_source(),
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
        refreshLabel={m.records_refresh()}
      />
      <p className="record-coverage">
        {m.records_coverage({ count: recordPageSize })}
      </p>
      {query.isPending ? (
        <p className="record-notice" role="status">
          {m.records_loading()}
        </p>
      ) : query.isPaused ? (
        <p className="record-notice" role="status">
          {m.records_offline()}
        </p>
      ) : error?.kind === 'access' ? (
        <p className="record-notice" role="alert">
          {m.records_no_access()}
        </p>
      ) : error?.kind === 'page' ? (
        <Alert role="alert">
          {error.message ?? m.records_page_link_stale()}{' '}
          <Button variant="outline" onClick={() => goTo(undefined, undefined)}>
            {m.records_first_page()}
          </Button>
        </Alert>
      ) : query.isError ? (
        <p className="record-notice" role="alert">
          {m.records_failed()}
        </p>
      ) : (
        <>
          <DataTable
            caption={m.records_table_caption()}
            columns={recordColumns((record) =>
              recordHref(organizationId, record.kind, record.id, search),
            )}
            rows={query.data.items}
            rowKey={(record) => `${record.kind}:${record.id}`}
            rowHeader="record"
            empty={<p className="record-notice">{m.records_empty()}</p>}
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
              emptyLabel={m.records_pagination_empty()}
              label={m.records_pagination_label()}
            />
          ) : null}
          {search.cursor && position < 0 ? (
            <Button variant="ghost" onClick={() => goTo(undefined, undefined)}>
              {m.records_return_first_page()}
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

function lineQuantity(value: unknown) {
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string' && value) return value;

  return null;
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
      <h3>{m.records_lines_title()}</h3>
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
                    {m.records_line_sku({ id: skuId.slice(0, 8) })}{' '}
                    <ArrowRight size={12} aria-hidden="true" />
                  </a>
                ) : (
                  m.records_line({
                    line: lineId?.slice(0, 8) ?? formatNumber(index + 1),
                  })
                )}
              </span>
              <span>
                {lineQuantity(line.quantity) ?? m.common_unknown()}{' '}
                {typeof line.unit === 'string'
                  ? quantityUnit(line.unit, String(line.quantity ?? ''))
                  : String(line.unit ?? '')}
                {line.cancelledQuantity
                  ? ` · ${m.records_line_canceled({
                      quantity:
                        lineQuantity(line.cancelledQuantity) ??
                        String(line.cancelledQuantity),
                    })}`
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
  const listHref = `/app/${encodeURIComponent(organizationId)}/records${listParams.size ? `?${listParams}` : ''}`;
  const record = query.data?.record;
  const denied =
    query.error instanceof IdentityError &&
    [401, 403].includes(query.error.status);

  return (
    <div className="records-page record-detail-page">
      <RecordHeader
        section={{
          label: m.records_title(),
          icon: Database,
          link: <a href={listHref} />,
        }}
        title={record?.label ?? m.records_detail_title_fallback()}
        back={returnPath ? <a href={returnPath} /> : undefined}
        status={
          record ? (
            <Badge
              tone={record.coverage === 'projected' ? 'neutral' : 'warning'}
            >
              {record.coverage === 'projected'
                ? record.status
                : record.sources.length === 1 && record.sources[0]
                  ? m.records_detail_id_only_source({
                      source: record.sources[0].label,
                    })
                  : m.records_detail_id_only()}
            </Badge>
          ) : null
        }
        description={
          record ? `${kindLabels[record.kind]()} · ${record.description}` : null
        }
      />
      {!parsed.success ? (
        <p className="record-notice">{m.records_detail_kind_unknown()}</p>
      ) : query.isPending ? (
        <p className="record-notice" role="status">
          {m.records_detail_loading()}
        </p>
      ) : query.isPaused ? (
        <p className="record-notice">{m.records_detail_offline()}</p>
      ) : denied ? (
        <p className="record-notice" role="alert">
          {m.records_no_access()}
        </p>
      ) : query.isError ? (
        <p className="record-notice" role="alert">
          {m.records_detail_failed()}
        </p>
      ) : record ? (
        <>
          <div className="record-detail-grid">
            <section className="record-card">
              <h2>{m.records_detail_data_title()}</h2>
              <p className="record-note">{m.records_detail_data_note()}</p>
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
                        )?.label ?? m.records_detail_source_fallback()}
                      </strong>
                      <span>
                        {rich(m.records_last_read, {
                          date: <WorkspaceDate value={snapshot.observedAt} />,
                        })}
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
                                m.common_unknown()
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
                <p className="record-note">{m.records_detail_data_empty()}</p>
              )}
            </section>
            <aside className="record-detail-side">
              <section className="record-card">
                <h2>{m.common_sources()}</h2>
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
                        <small>
                          {m.records_detail_source_id({
                            id: source.externalId,
                          })}
                        </small>
                      ) : null}
                      <small>
                        {source.mappingMethod
                          ? m.records_detail_link_method({
                              method: linkMethodLabel(source.mappingMethod),
                            })
                          : m.records_detail_link_derived()}
                      </small>
                      <small>
                        {source.sourceUpdatedAt
                          ? rich(m.records_detail_source_updated, {
                              date: (
                                <WorkspaceDate value={source.sourceUpdatedAt} />
                              ),
                            })
                          : m.records_detail_source_updated_unknown()}
                      </small>
                      <small>
                        {source.observedAt
                          ? rich(m.records_last_read, {
                              date: <WorkspaceDate value={source.observedAt} />,
                            })
                          : m.records_detail_last_read_unknown()}
                      </small>
                    </div>
                  ))
                ) : (
                  <p className="record-note">{m.records_detail_luma_issue()}</p>
                )}
              </section>
              <section className="record-card">
                <h2>{m.records_detail_related_title()}</h2>
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
                    {m.records_detail_related_empty()}
                  </p>
                )}
                {record.kind === 'issue' ? (
                  <Link
                    to="/app/$organizationId/exceptions/$exceptionId"
                    params={{ organizationId, exceptionId: record.id }}
                    search={{ view: 'needs_you' }}
                    className="record-action"
                  >
                    {m.records_detail_investigate_issue()}{' '}
                    <ArrowRight size={14} />
                  </Link>
                ) : record.kind === 'position' ? (
                  <Link
                    to="/app/$organizationId/inventory/$positionId"
                    params={{ organizationId, positionId: record.id }}
                    className="record-action"
                  >
                    {m.records_detail_open_inventory()} <ArrowRight size={14} />
                  </Link>
                ) : record.kind === 'sku' ? (
                  <>
                    <Link
                      to="/app/$organizationId/products/$skuId"
                      params={{ organizationId, skuId: record.id }}
                      className="record-action"
                    >
                      {m.records_detail_open_products()}{' '}
                      <ArrowRight size={14} />
                    </Link>
                    <Link
                      to="/app/$organizationId/inventory"
                      params={{ organizationId }}
                      search={{ skuId: record.id }}
                      className="record-action"
                    >
                      {m.records_detail_sku_stock()} <ArrowRight size={14} />
                    </Link>
                  </>
                ) : record.kind === 'order' ? (
                  <Link
                    to="/app/$organizationId/orders/$orderId"
                    params={{ organizationId, orderId: record.id }}
                    className="record-action"
                  >
                    {m.records_detail_open_orders()} <ArrowRight size={14} />
                  </Link>
                ) : record.kind === 'fulfillment' ? (
                  <Link
                    to="/app/$organizationId/fulfillment/$fulfillmentId"
                    params={{ organizationId, fulfillmentId: record.id }}
                    className="record-action"
                  >
                    {m.records_detail_open_fulfillment()}{' '}
                    <ArrowRight size={14} />
                  </Link>
                ) : null}
              </section>
            </aside>
          </div>
        </>
      ) : null}
    </div>
  );
}
