import './inventory.css';

import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  CollectionToolbar,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
import { Empty } from '@luma/ui/components/primitives/empty';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';

import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { SyncCoverage } from '../sync/coverage';
import { transferOptions, transfersOptions } from './data';
import { TransferDetailView } from './transfer-detail';
import { TransferTable } from './transfer-table';

/** Browses source transfers and receiving records without adding their quantities to stock. */
export function TransfersPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/inventory/transfers/',
  });
  const search = useSearch({
    from: '/app/$organizationId/inventory/transfers/',
  });
  const navigate = useNavigate({
    from: '/app/$organizationId/inventory/transfers/',
  });
  const query = useQuery(transfersOptions(organizationId, search));
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;
  const kind = search.kind ?? 'inventory_transfer';

  return (
    <main className="inventory-page">
      <Link to="/app/$organizationId/inventory" params={{ organizationId }}>
        {m.inventory_transfer_stock()}
      </Link>
      <PageHeader title={m.inventory_transfer_title()} />
      <p>{m.inventory_transfer_intro()}</p>
      <CollectionToolbar
        refreshLabel={m.inventory_list_refresh()}
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
        views={
          <CollectionViews
            label={m.inventory_list_views_label()}
            value={kind}
            views={[
              {
                value: 'inventory_transfer',
                label: m.inventory_transfer_transfers(),
              },
              {
                value: 'inventory_shipment',
                label: m.inventory_transfer_shipments(),
              },
            ]}
            onChange={(value) =>
              void navigate({
                search: { ...search, kind: value, cursor: undefined },
              })
            }
          />
        }
        filters={[
          {
            kind: 'applied',
            key: 'skuId',
            label: m.inventory_filter_sku(),
            value: search.skuId ? m.inventory_selected_sku() : undefined,
            onRemove: () =>
              void navigate({
                search: { ...search, skuId: undefined, cursor: undefined },
              }),
          },
          {
            kind: 'applied',
            key: 'locationId',
            label: m.inventory_filter_location(),
            value: search.locationId
              ? m.inventory_selected_location()
              : undefined,
            onRemove: () =>
              void navigate({
                search: { ...search, locationId: undefined, cursor: undefined },
              }),
          },
          {
            kind: 'applied',
            key: 'connectionId',
            label: m.inventory_filter_source(),
            value: search.connectionId
              ? (query.data?.items.find(
                  (item) => item.connectionId === search.connectionId,
                )?.label ?? m.inventory_selected_source())
              : undefined,
            onRemove: () =>
              void navigate({
                search: {
                  ...search,
                  connectionId: undefined,
                  cursor: undefined,
                },
              }),
          },
        ]}
        onClear={() => void navigate({ search: { kind: search.kind } })}
        search={{
          value: search.q,
          label: m.inventory_transfer_search(),
          placeholder: m.inventory_transfer_search(),
          onChange: (q) =>
            void navigate({ search: { ...search, q, cursor: undefined } }),
        }}
      />
      <SyncCoverage
        organizationId={organizationId}
        type={
          kind === 'inventory_transfer'
            ? 'inventory_transfers'
            : 'inventory_shipments'
        }
      />
      {query.isPaused ? <Alert>{m.inventory_offline()}</Alert> : null}
      {query.isError ? (
        <Alert role="alert" tone="danger">
          {query.error.message}
        </Alert>
      ) : query.isPending ? (
        <p role="status">{m.inventory_transfer_loading()}</p>
      ) : query.data.items.length ? (
        <TransferTable
          organizationId={organizationId}
          items={query.data.items}
        />
      ) : (
        <Empty>
          <h2>{m.inventory_transfer_empty()}</h2>
          <p>{m.inventory_transfer_empty_body()}</p>
        </Empty>
      )}
      {search.cursor ? (
        <Button
          variant="outline"
          onClick={() =>
            void navigate({ search: { ...search, cursor: undefined } })
          }
        >
          {m.inventory_list_first_page()}
        </Button>
      ) : null}
      {query.data?.nextCursor ? (
        <Button
          variant="outline"
          onClick={() =>
            void navigate({
              search: {
                ...search,
                cursor: query.data?.nextCursor ?? undefined,
              },
            })
          }
        >
          {m.inventory_list_next()}
        </Button>
      ) : null}
    </main>
  );
}

/** Loads exact receiving evidence for the selected source rather than combining providers. */
export function TransferPage() {
  const { organizationId, transferId } = useParams({
    from: '/app/$organizationId/inventory/transfers/$transferId',
  });
  const { connectionId } = useSearch({
    from: '/app/$organizationId/inventory/transfers/$transferId',
  });
  const query = useQuery(
    transferOptions(organizationId, transferId, connectionId),
  );
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;

  return (
    <main className="inventory-page">
      <Link
        to="/app/$organizationId/inventory/transfers"
        params={{ organizationId }}
      >
        {m.inventory_transfer_back()}
      </Link>

      {query.isPaused ? <Alert>{m.inventory_offline()}</Alert> : null}
      {query.isError ? (
        <Alert role="alert" tone="danger">
          {query.error.message}
        </Alert>
      ) : query.isPending ? (
        <p role="status">{m.inventory_transfer_loading()}</p>
      ) : (
        <TransferDetailView
          organizationId={organizationId}
          detail={query.data}
          actions={
            <RefreshButton
              label={m.inventory_list_refresh()}
              refreshing={query.isFetching}
              onClick={() => void query.refetch()}
            />
          }
        />
      )}
    </main>
  );
}
