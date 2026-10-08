import './customers.css';

import type { CustomerDetail } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { Empty } from '@luma/ui/components/primitives/empty';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { RefreshCw, UsersRound } from 'lucide-react';
import { type ReactNode, useSyncExternalStore } from 'react';

import { appsOptions } from '../apps/data';
import { AppExtension } from '../apps/extension';
import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { formatMoney } from '../orders/presentation';
import { systemName } from '../products/presentation';
import { sourceId } from '../sync/presentation';
import { customerOptions } from './data';
import {
  addressLines,
  customerName,
  stateDescriptions,
  stateLabels,
} from './presentation';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

export type CustomerError = 'missing' | 'access' | 'unavailable';

/** Loads one imported customer and mounts its live order history from the source's app. */
export function CustomerPage() {
  const { organizationId, customerId } = useParams({
    from: '/app/$organizationId/customers/$customerId',
  });
  const query = useQuery(customerOptions(organizationId, customerId));
  const apps = useQuery(appsOptions(organizationId));
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;
  const status = query.error instanceof IdentityError ? query.error.status : 0;
  const detail = status === 403 ? undefined : query.data;
  const appId = detail?.source?.appId;
  const historyApp =
    !!appId &&
    (apps.data?.catalog ?? []).some(
      (app) =>
        app.id === appId &&
        app.ui.includes('customers') &&
        apps.data?.installations.some(
          (item) => item.appId === app.id && item.status === 'installed',
        ),
    );

  return (
    <CustomerDetailView
      organizationId={organizationId}
      detail={detail}
      loading={query.isPending}
      refreshing={query.isFetching}
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
      history={
        detail && appId && historyApp ? (
          <AppExtension
            key={detail.item.id}
            appId={appId}
            organizationId={organizationId}
            slot="customers"
            customer={{
              connectionId: detail.item.connectionId,
              id: detail.item.externalId,
            }}
            done={async () => undefined}
          />
        ) : null
      }
    />
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card as="section" aria-label={title}>
      <CardHeader>
        <div>
          <CardTitle as="h2">{title}</CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Withheld() {
  return <span className="customers-muted">{m.customers_not_shared()}</span>;
}

function Missing() {
  return <span className="customers-muted">{m.common_not_reported()}</span>;
}

/** Shows one customer: imported profile facts beside live order history from the source. */
export function CustomerDetailView({
  organizationId,
  detail,
  error,
  loading = false,
  refreshing = false,
  offline = false,
  refresh,
  history,
}: {
  organizationId: string;
  detail?: CustomerDetail | undefined;
  error?: CustomerError | undefined;
  loading?: boolean;
  refreshing?: boolean;
  offline?: boolean;
  refresh: () => void;
  /** Live order history and service context from the source's app. */
  history?: ReactNode;
}) {
  const item = detail?.item;
  const store = detail?.source ? systemName(detail.source.system) : null;
  const withheld = <Withheld />;
  const missing = <Missing />;
  const address = addressLines(detail?.address ?? null);

  return (
    <div className="customers-page">
      <RecordHeader
        section={{
          label: m.customers_page_title(),
          domain: 'customers',
          link: (
            <Link
              to="/app/$organizationId/customers"
              params={{ organizationId }}
            />
          ),
        }}
        title={item ? customerName(item) : m.customers_detail_title_fallback()}
        description={
          item
            ? m.customers_detail_description({
                source: detail?.source?.label ?? m.customers_source_fallback(),
                id: sourceId(item.externalId),
              })
            : undefined
        }
        actions={
          <Button variant="outline" disabled={refreshing} onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" />
            {m.customers_detail_refresh()}
          </Button>
        }
      />
      {offline ? (
        <Alert role="status">{m.customers_detail_offline()}</Alert>
      ) : null}
      {error === 'missing' ? (
        <Empty>
          <UsersRound size={30} aria-hidden="true" />
          <h2>{m.customers_detail_missing_title()}</h2>
          <p>{m.customers_detail_missing_body()}</p>
          <Link to="/app/$organizationId/customers" params={{ organizationId }}>
            {m.customers_detail_browse()}
          </Link>
        </Empty>
      ) : error === 'access' ? (
        <Alert tone="danger" role="alert">
          {m.customers_access_lost()}
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {detail
            ? m.customers_detail_refresh_failed()
            : m.customers_detail_load_failed()}{' '}
          <Button variant="outline" onClick={refresh}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {loading && !error ? (
        <div className="customers-loading" role="status">
          <span className="sr-only">{m.customers_detail_loading()}</span>
          {Array.from({ length: 3 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
      {detail && item && error !== 'missing' ? (
        <div className="customers-layout">
          <div className="customers-main">
            <Section
              title={m.customers_history_title()}
              description={
                store
                  ? m.customers_history_description({ store })
                  : m.customers_history_description_generic()
              }
            >
              {history ?? (
                <p className="customers-muted">
                  {store
                    ? m.customers_history_unavailable({ store })
                    : m.customers_history_unavailable_generic()}
                </p>
              )}
            </Section>
          </div>
          <aside
            className="customers-inspector"
            aria-label={m.customers_profile_label()}
          >
            <Section title={m.customers_contact_title()}>
              <dl className="customers-facts">
                <Fact label={m.customers_fact_email()}>
                  {!item.shared.contact ? withheld : (item.email ?? missing)}
                </Fact>
                <Fact label={m.customers_fact_phone()}>
                  {!item.shared.contact ? withheld : (item.phone ?? missing)}
                </Fact>
                <Fact label={m.customers_fact_address()}>
                  {!item.shared.address
                    ? withheld
                    : address
                      ? address.map((line) => (
                          <span className="customers-line" key={line}>
                            {line}
                          </span>
                        ))
                      : missing}
                </Fact>
              </dl>
              {!item.shared.contact || !item.shared.address ? (
                <p className="customers-note">
                  {store
                    ? m.customers_contact_note({ store })
                    : m.customers_contact_note_generic()}
                </p>
              ) : null}
            </Section>
            <Section
              title={
                store
                  ? m.customers_store_title({ store })
                  : m.customers_store_title_generic()
              }
            >
              <dl className="customers-facts">
                <Fact label={m.customers_fact_orders()}>
                  {item.orderCount === null
                    ? missing
                    : formatNumber(item.orderCount)}
                </Fact>
                <Fact label={m.customers_fact_spent()}>
                  {formatMoney(item.amountSpent) ?? missing}
                </Fact>
                <Fact label={m.customers_fact_since()}>
                  {item.sourceCreatedAt ? (
                    <WorkspaceDate
                      value={item.sourceCreatedAt}
                      precision="day"
                    />
                  ) : (
                    missing
                  )}
                </Fact>
                <Fact label={m.customers_fact_account()}>
                  <span title={stateDescriptions[item.state]}>
                    {stateLabels[item.state]}
                  </span>
                </Fact>
                {item.tags.length ? (
                  <Fact label={m.customers_fact_tags()}>
                    <span className="customers-tags">
                      {item.tags.map((tag) => (
                        <Badge key={tag}>{tag}</Badge>
                      ))}
                    </span>
                  </Fact>
                ) : null}
              </dl>
            </Section>
            <Section title={m.customers_source_title()}>
              <dl className="customers-facts">
                <Fact label={m.customers_fact_source()}>
                  {detail.source?.label ?? m.customers_source_fallback()}
                </Fact>
                <Fact label={m.customers_fact_source_id()}>
                  <code>{item.externalId}</code>
                </Fact>
                <Fact label={m.customers_fact_updated()}>
                  {item.sourceUpdatedAt ? (
                    <WorkspaceDate value={item.sourceUpdatedAt} />
                  ) : (
                    missing
                  )}
                </Fact>
                <Fact label={m.customers_fact_read()}>
                  <WorkspaceDate value={item.observedAt} />
                </Fact>
              </dl>
              <p className="customers-note">{m.customers_source_note()}</p>
            </Section>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
