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
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { UsersRound } from 'lucide-react';
import { type ReactNode, useSyncExternalStore } from 'react';

import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { RecordAssistance } from '../../kit/record-assistance';
import { RecordMessages } from '../../kit/record-messages';
import { formatMoney } from '../../shared/orders/presentation';
import { RecordFields } from '../adaptive/record-fields';
import { systemName } from '../products/presentation';
import { CustomerReturnCases } from '../returns/case-list';
import { customerFilters, customerOptions, type CustomersSearch } from './data';
import { CustomerOrders } from './orders';
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

/** Loads one imported customer and the Luma orders its source attributes to them. */
export function CustomerPage() {
  const { organizationId, customerId } = useParams({
    from: '/app/$organizationId/customers/$customerId',
  });
  const search = useSearch({
    from: '/app/$organizationId/customers/$customerId',
  });
  const query = useQuery(customerOptions(organizationId, customerId));
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;
  const status = query.error instanceof IdentityError ? query.error.status : 0;
  const detail = status === 403 ? undefined : query.data;

  return (
    <CustomerDetailView
      contextualAssistance
      organizationId={organizationId}
      search={search}
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
      messages={
        detail ? (
          <RecordMessages
            organizationId={organizationId}
            kind="customer"
            recordId={detail.item.id}
            frame={(content) => (
              <Section title={m.messaging_record_section_title()}>
                {content}
              </Section>
            )}
          />
        ) : null
      }
      history={
        detail ? (
          <>
            <RecordFields
              organizationId={organizationId}
              recordType="customer"
              recordId={detail.item.id}
            />
            <CustomerOrders
              key={detail.item.id}
              organizationId={organizationId}
              customerId={detail.item.id}
            />
            <CustomerReturnCases
              key={`returns:${detail.item.id}`}
              organizationId={organizationId}
              customerId={detail.item.id}
            />
          </>
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

/** Shows one customer: imported profile facts beside the orders Luma imported for them. */
export function CustomerDetailView({
  contextualAssistance = false,
  organizationId,
  search = {},
  detail,
  error,
  loading = false,
  refreshing = false,
  offline = false,
  refresh,
  history,
  messages,
}: {
  organizationId: string;
  /** The list state the customer was opened from; the breadcrumb returns to it. */
  search?: CustomersSearch;
  /** The connected page supplies the authorized assistant control. */
  contextualAssistance?: boolean;
  detail?: CustomerDetail | undefined;
  error?: CustomerError | undefined;
  loading?: boolean;
  refreshing?: boolean;
  offline?: boolean;
  refresh: () => void;
  /** The customer's order history. */
  history?: ReactNode;
  /** Message threads linked to the customer. */
  messages?: ReactNode;
}) {
  const item = detail?.item;
  const store = detail?.source ? systemName(detail.source.system) : null;
  const withheld = <Withheld />;
  const missing = <Missing />;
  const address = addressLines(detail?.address ?? null);
  const listSearch: CustomersSearch = {
    ...customerFilters(search),
    cursor: search.cursor,
    page: search.page,
  };

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
              search={listSearch}
            />
          ),
        }}
        title={item ? customerName(item) : m.customers_detail_title_fallback()}
        description={
          item
            ? m.customers_detail_description({
                source: detail?.source?.label ?? m.customers_source_fallback(),
              })
            : undefined
        }
        actions={
          <>
            {item ? (
              contextualAssistance ? (
                <RecordAssistance
                  organizationId={organizationId}
                  context={{ record: { kind: 'customer', id: item.id } }}
                  label={customerName(item)}
                />
              ) : null
            ) : null}
            <RefreshButton
              refreshing={refreshing}
              onClick={refresh}
              label={m.customers_detail_refresh()}
            />
          </>
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
      {item?.missingSince && error !== 'missing' ? (
        <Alert tone="warning">
          {m.customers_gone_notice({
            source: detail?.source?.label ?? m.customers_source_fallback(),
          })}
        </Alert>
      ) : null}
      {detail && item && error !== 'missing' ? (
        <div className="customers-layout">
          <div className="customers-main">
            <Section
              title={m.customers_history_title()}
              description={m.customers_history_description({
                source: detail.source?.label ?? m.customers_source_fallback(),
              })}
            >
              {history}
            </Section>
            {messages}
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
                {/* Some sources, such as JTL, report neither; the order history counts imported orders. */}
                {item.orderCount === null ? null : (
                  <Fact label={m.customers_fact_orders()}>
                    {formatNumber(item.orderCount)}
                  </Fact>
                )}
                {item.amountSpent === null ? null : (
                  <Fact label={m.customers_fact_spent()}>
                    {formatMoney(item.amountSpent) ?? missing}
                  </Fact>
                )}
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
                  <span
                    title={m.customers_source_id_title({
                      id: item.externalId,
                    })}
                  >
                    {detail.source?.label ?? m.customers_source_fallback()}
                  </span>
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
                {item.missingSince ? (
                  <Fact label={m.customers_fact_gone()}>
                    <WorkspaceDate value={item.missingSince} />
                  </Fact>
                ) : null}
              </dl>
              <p className="customers-note">{m.customers_source_note()}</p>
            </Section>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
