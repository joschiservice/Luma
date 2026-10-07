import './customers.css';

import type { CustomerDetail } from '@luma/api-contract';
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
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, RefreshCw, UsersRound } from 'lucide-react';
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

const withheld = <span className="customers-muted">Not shared</span>;

const missing = <span className="customers-muted">Not reported</span>;

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
  const store = detail?.source
    ? systemName(detail.source.system)
    : 'the source';
  const address = addressLines(detail?.address ?? null);

  return (
    <main className="customers-page">
      <Link
        className="customers-back"
        to="/app/$organizationId/customers"
        params={{ organizationId }}
      >
        <ArrowLeft size={14} aria-hidden="true" />
        Back to customers
      </Link>
      <PageHeader
        title={item ? customerName(item) : 'Customer'}
        icon={<DomainIcon domain="customers" size="md" />}
        description={
          item
            ? `${detail?.source?.label ?? 'Connected source'} · Source ID ${sourceId(item.externalId)}`
            : 'A customer’s profile and order history in one connected store.'
        }
        actions={
          <Button variant="outline" disabled={refreshing} onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" />
            Refresh customer
          </Button>
        }
      />
      {offline ? (
        <Alert role="status">
          You are offline. The customer below may be out of date.
        </Alert>
      ) : null}
      {error === 'missing' ? (
        <Empty>
          <UsersRound size={30} aria-hidden="true" />
          <h2>Customer not found</h2>
          <p>
            This customer is not in this workspace, or the store asked Luma to
            erase their data.
          </p>
          <Link to="/app/$organizationId/customers" params={{ organizationId }}>
            Browse customers
          </Link>
        </Empty>
      ) : error === 'access' ? (
        <Alert tone="danger" role="alert">
          You no longer have access to customers in this workspace.
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {detail
            ? 'This customer could not be refreshed. The details below may be out of date.'
            : 'This customer could not be loaded.'}{' '}
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {loading && !error ? (
        <div className="customers-loading" role="status">
          <span className="sr-only">Loading customer…</span>
          {Array.from({ length: 3 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
      {detail && item && error !== 'missing' ? (
        <div className="customers-layout">
          <div className="customers-main">
            <Section
              title="Order history"
              description={`Orders, fulfillment, returns and refunds read live from ${store} with the connection’s permissions. Select an order to see its open issues and Luma actions.`}
            >
              {history ?? (
                <p className="customers-muted">
                  Order history is read live through the {store} app. Install
                  and authorize it in Apps to see this customer’s orders.
                </p>
              )}
            </Section>
          </div>
          <aside className="customers-inspector" aria-label="Customer profile">
            <Section title="Contact">
              <dl className="customers-facts">
                <Fact label="Email">
                  {!item.shared.contact ? withheld : (item.email ?? missing)}
                </Fact>
                <Fact label="Phone">
                  {!item.shared.contact ? withheld : (item.phone ?? missing)}
                </Fact>
                <Fact label="Address">
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
                  {store} shares contact details and addresses only when the
                  deployment is approved for them.
                </p>
              ) : null}
            </Section>
            <Section title={`In ${store}`}>
              <dl className="customers-facts">
                <Fact label="Orders">
                  {item.orderCount?.toLocaleString() ?? missing}
                </Fact>
                <Fact label="Amount spent">
                  {formatMoney(item.amountSpent) ?? missing}
                </Fact>
                <Fact label="Customer since">
                  {item.sourceCreatedAt ? (
                    <WorkspaceDate
                      value={item.sourceCreatedAt}
                      precision="day"
                    />
                  ) : (
                    missing
                  )}
                </Fact>
                <Fact label="Account">
                  <span title={stateDescriptions[item.state]}>
                    {stateLabels[item.state]}
                  </span>
                </Fact>
                {item.tags.length ? (
                  <Fact label="Tags">
                    <span className="customers-tags">
                      {item.tags.map((tag) => (
                        <Badge key={tag}>{tag}</Badge>
                      ))}
                    </span>
                  </Fact>
                ) : null}
              </dl>
            </Section>
            <Section title="Source and evidence">
              <dl className="customers-facts">
                <Fact label="Source">
                  {detail.source?.label ?? 'Connected source'}
                </Fact>
                <Fact label="Source ID">
                  <code>{item.externalId}</code>
                </Fact>
                <Fact label="Updated in source">
                  {item.sourceUpdatedAt ? (
                    <WorkspaceDate value={item.sourceUpdatedAt} />
                  ) : (
                    missing
                  )}
                </Fact>
                <Fact label="Read by Luma">
                  <WorkspaceDate value={item.observedAt} />
                </Fact>
              </dl>
              <p className="customers-note">
                Each store keeps its own customers. Luma never merges customers
                across stores by name or email address.
              </p>
            </Section>
          </aside>
        </div>
      ) : null}
    </main>
  );
}
