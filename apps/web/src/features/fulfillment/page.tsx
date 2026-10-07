import './fulfillment.css';

import type {
  FulfillmentItem,
  FulfillmentList,
  FulfillmentView,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  type CollectionFilterOption,
  CollectionToolbar,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
import {
  DataTable,
  type DataTableColumn,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { CircleCheck, MapPin, Plug, Shapes, Truck } from 'lucide-react';
import { type ReactNode, useState, useSyncExternalStore } from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { recordReturnPath } from '../records/data';
import { SyncCoverage } from '../sync/coverage';
import { ago } from '../sync/presentation';
import {
  fulfillmentFilters,
  type FulfillmentSearch,
  fulfillmentsOptions,
} from './data';
import {
  fulfillmentReason,
  fulfillmentState,
  kindLabels,
  methodLabels,
  orderLabel,
  otherSignals,
  signalLabels,
  sortLabels,
  viewDescriptions,
  viewLabels,
} from './presentation';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

const views: FulfillmentView[] = [
  'attention',
  'held',
  'delayed',
  'open',
  'in_transit',
  'all',
];

// Views that list problems; a non-zero count is highlighted.
const warningViews = new Set<FulfillmentView>(['attention', 'held', 'delayed']);

const kinds = ['fulfillment_order', 'shipment'] as const;

const kindFilterLabels: Record<(typeof kinds)[number], string> = {
  fulfillment_order: 'Fulfillment orders',
  shipment: 'Shipments',
};

const sorts = ['waiting', 'recent', 'deadline'] as const;

/** Keeps a selected filter value that the loaded page does not list, so its chip stays readable. */
function withSelected(
  options: CollectionFilterOption[],
  selected: string | undefined,
  label: string,
): CollectionFilterOption[] {
  return selected && !options.some((option) => option.value === selected)
    ? [...options, { value: selected, label }]
    : options;
}

/** Connects the fulfillment list to workspace-scoped queries and shareable URL filters. */
export function FulfillmentPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/fulfillment/',
  });
  const search = useSearch({ from: '/app/$organizationId/fulfillment/' });
  const navigate = useNavigate({ from: '/app/$organizationId/fulfillment/' });
  const query = useQuery(fulfillmentsOptions(organizationId, search));
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  const [trails, setTrails] = useState<Record<string, (string | undefined)[]>>(
    {},
  );
  const filterKey = JSON.stringify(fulfillmentFilters(search));
  const trail = trails[filterKey] ?? [undefined];
  const index = trail.indexOf(search.cursor);
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;
  const change = (next: FulfillmentSearch) =>
    void navigate({ search: next, resetScroll: false });

  return (
    <FulfillmentView
      coverage={<SyncCoverage organizationId={organizationId} type="orders" />}
      organizationId={organizationId}
      search={search}
      list={query.isError ? undefined : query.data}
      stale={query.isError ? query.data : undefined}
      loading={query.isPending}
      error={query.error?.message}
      offline={!online}
      refreshing={query.isFetching}
      change={change}
      next={
        query.data?.nextCursor
          ? () => {
              const cursor = query.data.nextCursor!;
              if (index >= 0)
                setTrails((previous) => ({
                  ...previous,
                  [filterKey]: [...trail.slice(0, index + 1), cursor],
                }));
              change({ ...search, cursor });
            }
          : undefined
      }
      previous={
        index > 0
          ? () => change({ ...search, cursor: trail[index - 1] })
          : undefined
      }
      refresh={() => void query.refetch()}
    />
  );
}

/** Shows when the fulfillment last moved and the date it is measured against. */
function ProgressCell({ item, asOf }: { item: FulfillmentItem; asOf: string }) {
  const now = Date.parse(asOf);

  return (
    <span className="fulfillment-cell">
      <span>
        {item.lastProgressAt ? 'Progress' : 'Updated'}{' '}
        {ago(item.progressAt, now)}
      </span>
      {item.open && item.fulfillBy ? (
        <small>
          Fulfill by <WorkspaceDate value={item.fulfillBy} />
        </small>
      ) : item.status === 'shipped' && item.estimatedDeliveryAt ? (
        <small>
          Expected <WorkspaceDate value={item.estimatedDeliveryAt} />
        </small>
      ) : null}
    </span>
  );
}

function listColumns(
  organizationId: string,
  search: FulfillmentSearch,
  list: FulfillmentList,
): DataTableColumn<FulfillmentItem>[] {
  const sourceLabel = (connectionId: string) =>
    list.sources.find((source) => source.connectionId === connectionId)
      ?.label ?? 'Connected source';

  return [
    {
      key: 'fulfillment',
      header: 'Order / fulfillment',
      cell: (item) => (
        <span className="fulfillment-cell">
          <DataTableRowLink
            render={
              <Link
                to="/app/$organizationId/fulfillment/$fulfillmentId"
                params={{ organizationId, fulfillmentId: item.id }}
                search={search}
              />
            }
          >
            {orderLabel(item)}
          </DataTableRowLink>
          <small>
            {kindLabels[item.kind]} · {sourceLabel(item.connectionId)}
          </small>
          <small>
            {item.units} {item.unit ?? 'units'}
          </small>
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      cell: (item) => {
        const state = fulfillmentState(item);

        return (
          <span className="fulfillment-flags">
            <StatePill state={state.state}>{state.label}</StatePill>
            {otherSignals(item).map((signal) => (
              <Badge key={signal} tone="warning">
                {signalLabels[signal]}
              </Badge>
            ))}
          </span>
        );
      },
    },
    {
      key: 'reason',
      header: 'What’s happening',
      hideOnNarrow: true,
      cell: (item) => (
        <span className="fulfillment-reason">
          {fulfillmentReason(item, list.asOf)}
        </span>
      ),
    },
    {
      key: 'location',
      header: 'Location',
      hideOnNarrow: true,
      cell: (item) => (
        <span className="fulfillment-cell">
          <span>{item.location?.name ?? 'Not reported'}</span>
          {item.method ? (
            <small>
              {item.method.name ?? methodLabels[item.method.type] ?? 'Delivery'}
            </small>
          ) : null}
        </span>
      ),
    },
    {
      key: 'progress',
      header: 'Progress',
      hideOnNarrow: true,
      cell: (item) => <ProgressCell item={item} asOf={list.asOf} />,
    },
  ];
}

/** Explains an empty list for the current view and filters. */
function EmptyList({
  organizationId,
  view,
  filtered,
  clear,
}: {
  organizationId: string;
  view: FulfillmentView;
  filtered: boolean;
  clear: () => void;
}) {
  const calm =
    !filtered &&
    (view === 'attention' || view === 'held' || view === 'delayed');

  return (
    <Empty>
      {calm ? (
        <CircleCheck size={30} aria-hidden="true" />
      ) : (
        <Truck size={30} aria-hidden="true" />
      )}
      <h2>
        {calm
          ? 'Nothing is stuck right now'
          : filtered
            ? 'No fulfillments match'
            : view === 'all'
              ? 'No fulfillments yet'
              : `Nothing ${viewLabels[view].toLowerCase()}`}
      </h2>
      <p>
        {calm
          ? 'Held, delayed and failed fulfillments appear here as soon as a source reports them.'
          : filtered
            ? 'Try another order number, tracking number, location or source.'
            : view === 'all'
              ? 'Fulfillment orders and shipments appear once a connected store or ERP reports them. Check Data sync for progress.'
              : viewDescriptions[view]}
      </p>
      {filtered ? (
        <Button onClick={clear} variant="outline">
          Clear filters
        </Button>
      ) : view === 'all' ? (
        <Link to="/app/$organizationId/sync" params={{ organizationId }}>
          Open Data sync
        </Link>
      ) : null}
    </Empty>
  );
}

/** Presents fulfillment work with attention views, search, filters and paging. */
export function FulfillmentView({
  organizationId,
  search,
  list,
  stale,
  loading = false,
  error,
  offline = false,
  refreshing = false,
  change,
  refresh,
  next,
  previous,
  coverage,
}: {
  organizationId: string;
  search: FulfillmentSearch;
  list?: FulfillmentList | undefined;
  /** The last loaded page, shown read-only after a failed refresh. */
  stale?: FulfillmentList | undefined;
  loading?: boolean;
  error?: string | undefined;
  offline?: boolean;
  refreshing?: boolean;
  change: (search: FulfillmentSearch) => void;
  refresh: () => void;
  next?: (() => void) | undefined;
  previous?: (() => void) | undefined;
  /** Which sources the list covers. */
  coverage?: ReactNode;
}) {
  const update = (patch: Partial<FulfillmentSearch>) =>
    change({ ...fulfillmentFilters(search), from: search.from, ...patch });
  const clear = () => change({ from: search.from, view: search.view });
  const from = recordReturnPath(organizationId, search.from);
  const view = search.view ?? 'attention';
  const shownList = list ?? stale;
  const sources = shownList?.sources ?? [];
  const locations = shownList?.locations ?? [];
  const filtered = !!(
    search.q ||
    search.connectionId ||
    search.locationId ||
    search.kind
  );

  return (
    <main className="fulfillment-page">
      {from ? <Link to={from}>← Back to context</Link> : null}
      <PageTitle title="Fulfillment" />
      <CollectionToolbar
        refreshLabel="Refresh fulfillment"
        refreshing={refreshing}
        onRefresh={refresh}
        views={
          <CollectionViews
            label="Fulfillment views"
            value={view}
            views={views.map((option) => ({
              value: option,
              label: viewLabels[option],
              description: viewDescriptions[option],
              count: shownList?.counts[option],
              attention: warningViews.has(option),
            }))}
            onChange={(option) => update({ view: option })}
          />
        }
        search={{
          value: search.q,
          onChange: (q) => update({ q }),
          label: 'Search fulfillment',
          placeholder: 'Order, tracking number, location or source ID…',
        }}
        filters={[
          {
            kind: 'choice',
            key: 'connectionId',
            label: 'Source',
            icon: Plug,
            value: search.connectionId,
            options: withSelected(
              sources.length > 1 || search.connectionId
                ? sources.map((source) => ({
                    value: source.connectionId,
                    label: source.label,
                  }))
                : [],
              search.connectionId,
              'Selected source',
            ),
            onChange: (connectionId) => update({ connectionId }),
          },
          {
            kind: 'choice',
            key: 'locationId',
            label: 'Location',
            icon: MapPin,
            value: search.locationId,
            options: withSelected(
              locations.map((location) => ({
                value: location.id,
                label: `${location.name ?? 'Unnamed location'} · ${location.open} open`,
              })),
              search.locationId,
              'Selected location',
            ),
            onChange: (locationId) => update({ locationId }),
          },
          {
            kind: 'choice',
            key: 'kind',
            label: 'Type',
            icon: Shapes,
            value: search.kind,
            options: kinds.map((value) => ({
              value,
              label: kindFilterLabels[value],
            })),
            onChange: (value) =>
              update({ kind: kinds.find((item) => item === value) }),
          },
        ]}
        sort={{
          value: search.sort ?? 'waiting',
          options: sorts.map((value) => ({ value, label: sortLabels[value] })),
          onChange: (value) => {
            const sort = sorts.find((item) => item === value);
            update({ sort: sort === 'waiting' ? undefined : sort });
          },
        }}
        onClear={clear}
      />
      {coverage}
      <p className="fulfillment-note">
        Work without progress for {shownList?.stalledAfterHours ?? 48} hours
        counts as delayed. Each source’s work is listed separately.
      </p>
      {offline ? (
        <Alert role="status">
          You are offline. Reconnect to refresh fulfillment.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {stale
            ? 'Fulfillment could not be refreshed. The list below may be out of date.'
            : error}{' '}
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
          {search.cursor ? (
            <Button variant="ghost" onClick={() => update({})}>
              Go to first page
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {shownList ? (
        <>
          <DataTable
            className="fulfillment-list-table"
            caption={`${viewLabels[view]}: fulfillment orders and shipments with their state and next deadline`}
            columns={listColumns(organizationId, search, shownList)}
            rows={shownList.items}
            rowKey={(item) => `${item.id}:${item.connectionId}`}
            empty={
              <EmptyList
                organizationId={organizationId}
                view={view}
                filtered={filtered}
                clear={clear}
              />
            }
          />
          {shownList.items.length ? (
            <div className="fulfillment-pagination">
              <span>
                {shownList.items.length} of {shownList.counts[view]}{' '}
                {shownList.counts[view] === 1 ? 'fulfillment' : 'fulfillments'}
                {search.cursor ? ' on this page' : ''}
              </span>
              <div>
                {previous ? (
                  <Button
                    variant="outline"
                    disabled={refreshing}
                    onClick={previous}
                  >
                    Previous page
                  </Button>
                ) : null}
                {search.cursor ? (
                  <Button variant="ghost" onClick={() => update({})}>
                    First page
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  disabled={!next || refreshing}
                  onClick={next}
                >
                  Next page
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : loading && !error ? (
        <div className="fulfillment-loading" role="status">
          <span className="sr-only">Loading fulfillment…</span>
          {Array.from({ length: 5 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
    </main>
  );
}
