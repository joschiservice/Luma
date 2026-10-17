import { type OrderList, orderSortSchema } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PackageSearch } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../kit/identity/data';
import { sortLabels } from '../../shared/orders/presentation';
import { OrdersTable } from '../orders/list-table';
import {
  customerOrderPageSize,
  customerOrdersOptions,
  type CustomerOrdersState,
} from './data';

export type CustomerOrdersError = 'access' | 'page' | 'unavailable';

const firstPage: CustomerOrdersState = { sort: 'placed', direction: 'desc' };

// The history sits beside the profile, so it leaves out the source update time.
const columns = [
  'number',
  'placed',
  'status',
  'fulfillment',
  'total',
  'sources',
] as const;

/**
 * Loads the Luma orders of one imported customer and keeps a previous-page trail for the current
 * sort. Mount it with the customer ID as key, so another customer starts on the first page.
 */
export function CustomerOrders({
  organizationId,
  customerId,
}: {
  organizationId: string;
  customerId: string;
}) {
  const [state, setState] = useState(firstPage);
  const [trail, setTrail] = useState<(string | undefined)[]>([undefined]);
  const list = useQuery({
    ...customerOrdersOptions(organizationId, customerId, state),
    // Keep the current page visible while the next one loads.
    placeholderData: (previous) => previous,
  });
  const position = Math.max(0, trail.indexOf(state.cursor));
  const status = list.error instanceof ApiError ? list.error.status : undefined;
  const error: CustomerOrdersError | undefined = !list.error
    ? undefined
    : status === 403 || status === 404
      ? 'access'
      : status === 400 && state.cursor
        ? 'page'
        : 'unavailable';
  const restart = (next: CustomerOrdersState) => {
    setTrail([undefined]);
    setState({ sort: next.sort, direction: next.direction });
  };

  return (
    <CustomerOrdersView
      organizationId={organizationId}
      customerPath={`/app/${encodeURIComponent(organizationId)}/customers/${encodeURIComponent(customerId)}`}
      state={state}
      list={error === 'access' ? undefined : list.data}
      loading={list.isPending}
      error={error}
      page={position + 1}
      change={restart}
      retry={() => (error === 'page' ? restart(state) : void list.refetch())}
      next={
        list.data?.nextCursor
          ? () => {
              const cursor = list.data.nextCursor!;
              setTrail([...trail.slice(0, position + 1), cursor]);
              setState({ ...state, cursor });
            }
          : undefined
      }
      previous={
        position > 0
          ? () => setState({ ...state, cursor: trail[position - 1] })
          : undefined
      }
    />
  );
}

/** Presents one page of a customer's orders with its loading, empty, access and failure states. */
export function CustomerOrdersView({
  organizationId,
  customerPath,
  state,
  list,
  loading = false,
  error,
  page,
  change,
  retry,
  next,
  previous,
}: {
  organizationId: string;
  /** Where an opened order returns to. */
  customerPath: string;
  state: CustomerOrdersState;
  list?: OrderList | undefined;
  loading?: boolean;
  error?: CustomerOrdersError | undefined;
  page: number;
  change: (next: CustomerOrdersState) => void;
  retry: () => void;
  next?: (() => void) | undefined;
  previous?: (() => void) | undefined;
}) {
  return (
    <div className="customer-orders" aria-busy={loading}>
      {error === 'access' ? (
        <Alert role="status">{m.customers_history_access()}</Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {error === 'page'
            ? m.customers_history_page_expired()
            : list
              ? m.customers_history_refresh_failed()
              : m.customers_history_load_failed()}{' '}
          <Button variant="outline" onClick={retry}>
            {error === 'page' ? m.orders_list_first_page() : m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {list ? (
        <>
          <OrdersTable
            caption={m.orders_list_caption({
              view: m.customers_history_title(),
              sort: sortLabels[state.sort],
            })}
            items={list.items}
            columns={columns}
            link={(order) => (
              <Link
                to="/app/$organizationId/orders/$orderId"
                params={{ organizationId, orderId: order.id }}
                search={{ from: customerPath }}
              />
            )}
            sort={{ key: state.sort, direction: state.direction }}
            onSortChange={(next) => {
              const sort = orderSortSchema.safeParse(next.key);
              change({
                sort: sort.success ? sort.data : firstPage.sort,
                direction: next.direction,
              });
            }}
            empty={
              <Empty>
                <PackageSearch size={30} aria-hidden="true" />
                <h2>{m.customers_history_empty_title()}</h2>
                <p>{m.customers_history_empty_body()}</p>
              </Empty>
            }
          />
          {list.items.length ? (
            <Pagination
              count={list.items.length}
              totalCount={list.totalCount ?? undefined}
              page={page}
              pageSize={customerOrderPageSize}
              hasNext={!!next}
              onPrevious={previous}
              onNext={() => next?.()}
              formatTotal={(count) => m.orders_list_pagination_total({ count })}
              label={m.customers_history_pagination_label()}
            />
          ) : null}
        </>
      ) : loading && !error ? (
        <div className="customers-loading" role="status">
          <span className="sr-only">{m.customers_history_loading()}</span>
          {Array.from({ length: 3 }, (_, index) => (
            <span className="lu-skeleton" key={index} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
