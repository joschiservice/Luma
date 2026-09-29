import './orders.css';

import type { OrderDetail, OrderSourceFacts } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { workspaceDateValue } from '@luma/ui/lib/timezone';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import {
  type ReactNode,
  useContext,
  useState,
  useSyncExternalStore,
} from 'react';

import { appsOptions } from '../apps/data';
import { AppExtension } from '../apps/extension';
import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { recordReturnPath } from '../records/data';
import { orderFilters, orderOptions, type OrdersSearch } from './data';
import { OrderHeader } from './order-header';
import { OrderInspector } from './order-inspector';
import { OrderSection } from './order-section';
import {
  LumaActivity,
  ObservedHistory,
  OrderFulfillments,
} from './order-timeline';
import { orderSummary } from './presentation';
import { OrderLines, SourceComparison } from './source-facts';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

/** Loads one order and mounts live context from installed apps that support records. */
export function OrderPage() {
  const { organizationId, orderId } = useParams({
    from: '/app/$organizationId/orders/$orderId',
  });
  const search = useSearch({ from: '/app/$organizationId/orders/$orderId' });
  const query = useQuery(orderOptions(organizationId, orderId));
  const apps = useQuery(appsOptions(organizationId));
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;
  const status = query.error instanceof IdentityError ? query.error.status : 0;
  const recordApps = new Set(
    (apps.data?.catalog ?? [])
      .filter(
        (app) =>
          app.ui.includes('record') &&
          apps.data?.installations.some(
            (item) => item.appId === app.id && item.status === 'installed',
          ),
      )
      .map((app) => app.id),
  );

  return (
    <OrderDetailView
      organizationId={organizationId}
      search={search}
      detail={status === 403 ? undefined : query.data}
      loading={query.isPending}
      offline={!online}
      error={
        !query.error
          ? undefined
          : status === 404
            ? 'missing'
            : status === 403
              ? 'access'
              : 'unavailable'
      }
      refresh={() => void query.refetch()}
      sourceContext={(source) =>
        source.appId && source.externalId && recordApps.has(source.appId) ? (
          <AppExtension
            appId={source.appId}
            organizationId={organizationId}
            slot="record"
            record={{
              kind: 'order',
              connectionId: source.connectionId,
              externalId: source.externalId,
            }}
            done={async () => undefined}
          />
        ) : null
      }
    />
  );
}

export type OrderError = 'missing' | 'access' | 'unavailable';

/** Presents one order's state, source facts, evidence and linked work with its unavailable states. */
export function OrderDetailView({
  organizationId,
  search,
  detail,
  loading = false,
  offline = false,
  error,
  refresh,
  sourceContext,
}: {
  organizationId: string;
  search: OrdersSearch;
  detail?: OrderDetail | undefined;
  loading?: boolean;
  offline?: boolean;
  error?: OrderError | undefined;
  refresh: () => void;
  sourceContext?: (source: OrderSourceFacts) => ReactNode;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const [chosen, setChosen] = useState<string | null>(null);
  const returnPath = recordReturnPath(organizationId, search.from);
  const listSearch = {
    ...orderFilters(search),
    cursor: search.cursor,
    page: search.page,
  };
  const here = detail
    ? `/app/${encodeURIComponent(organizationId)}/orders/${detail.order.id}`
    : '';
  const shown =
    detail?.sources.find((source) => source.connectionId === chosen) ??
    detail?.sources.find((source) => source.selected) ??
    detail?.sources[0];
  const contexts =
    detail && sourceContext
      ? detail.sources.flatMap((source) => {
          const content = sourceContext(source);

          return content ? [{ source, content }] : [];
        })
      : [];

  return (
    <main className="order-page">
      {returnPath ? (
        <a className="order-back" href={returnPath}>
          <ArrowLeft size={16} aria-hidden="true" /> Back to context
        </a>
      ) : (
        <Link
          className="order-back"
          to="/app/$organizationId/orders"
          params={{ organizationId }}
          search={listSearch}
        >
          <ArrowLeft size={16} aria-hidden="true" /> Back to orders
        </Link>
      )}
      {offline ? (
        <Alert role="status">
          You are offline. The order below may be out of date.
        </Alert>
      ) : null}
      {error === 'missing' ? (
        <Alert role="alert">
          This order is not in this workspace or is no longer reported by any
          source.
        </Alert>
      ) : error === 'access' ? (
        <Alert tone="danger" role="alert">
          You no longer have access to orders in this workspace.
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          The order could not be loaded.{' '}
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {!detail ? (
        loading && !error ? (
          <p role="status" className="order-note">
            Loading order…
          </p>
        ) : null
      ) : (
        <>
          <OrderHeader order={detail.order} />
          <div className="order-layout">
            <div className="order-main">
              <OrderSection
                title="Current state"
                description={`Based on ${shown?.label ?? 'the newest source'}, the source with the newest update. Other sources are compared below.`}
              >
                <ul className="order-summary">
                  {orderSummary(detail, (value) =>
                    workspaceDateValue(new Date(value), timeZone),
                  ).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </OrderSection>
              <OrderLines
                detail={detail}
                shown={shown}
                choose={setChosen}
                organizationId={organizationId}
                from={here}
              />
              {detail.sources.length > 1 ? (
                <SourceComparison detail={detail} />
              ) : null}
              <OrderFulfillments
                detail={detail}
                organizationId={organizationId}
                from={here}
              />
              {contexts.map(({ source, content }) => (
                <OrderSection
                  key={source.connectionId}
                  title={`${source.label} details`}
                  description="Payments, customer, fulfillment holds, returns, refunds and source events, read live with this connection's permissions. Luma does not store these details."
                >
                  {content}
                </OrderSection>
              ))}
              <ObservedHistory detail={detail} />
              <LumaActivity detail={detail} organizationId={organizationId} />
            </div>
            <OrderInspector
              detail={detail}
              organizationId={organizationId}
              here={here}
            />
          </div>
        </>
      )}
    </main>
  );
}
