import './orders.css';

import type { OrderDetail, OrderSourceFacts } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  formatWorkspaceDateTime,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  CircleCheck,
  CircleHelp,
  ClipboardList,
  Clock,
  GitCompareArrows,
  Inbox,
  Info,
  type LucideIcon,
  Mail,
  PackageOpen,
  Radio,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import {
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';

import { appsOptions } from '../../kit/apps/data';
import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { RecordMessages } from '../../kit/record-messages';
import { OrderSection } from '../../shared/orders/order-section';
import {
  orderSummary,
  type SummaryKind,
} from '../../shared/orders/presentation';
import { RecordFields } from '../adaptive/record-fields';
import { AppExtension } from '../apps/extension';
import { recordReturnPath } from '../records/data';
import { OrderReturnCases } from '../returns/case-entry';
import { OrderReturns } from '../returns/order-returns';
import {
  OrderChangePlanView,
  orderLocationNames,
  planLines,
} from './change-plan';
import {
  changePlanOptions,
  orderFilters,
  orderOptions,
  type OrdersSearch,
  proposedChange,
} from './data';
import { OrderIdentityLinks } from './identity-links';
import { OrderJourney } from './journey';
import { OrderLineIdentityLinks } from './line-identity-links';
import { NativeOrderStock } from './native-stock';
import { OrderCharges } from './order-charges';
import { OrderHeader } from './order-header';
import { OrderInspector } from './order-inspector';
import {
  LumaActivity,
  ObservedHistory,
  OrderFulfillments,
} from './order-timeline';
import { SalesRecord } from './sales-record';
import { OrderLines, SourceComparison } from './source-facts';

const summaryIcons: Record<SummaryKind, LucideIcon> = {
  state: Info,
  removed: Trash2,
  closed: CircleCheck,
  remaining: PackageOpen,
  unknown: CircleHelp,
  overdue: Clock,
  failed: TriangleAlert,
  issues: Inbox,
  differs: GitCompareArrows,
};

const summaryTones: Record<
  SummaryKind,
  'neutral' | 'warning' | 'danger' | 'success'
> = {
  state: 'neutral',
  removed: 'warning',
  closed: 'success',
  remaining: 'neutral',
  unknown: 'warning',
  overdue: 'danger',
  failed: 'danger',
  issues: 'warning',
  differs: 'warning',
};

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
  const navigate = useNavigate();
  useEffect(() => {
    if (query.data && query.data.order.id !== orderId)
      void navigate({
        to: '/app/$organizationId/orders/$orderId',
        params: { organizationId, orderId: query.data.order.id },
        search: { ...search, linkedFrom: orderId },
        replace: true,
      });
  }, [query.data, orderId, organizationId, search, navigate]);
  const apps = useQuery(appsOptions(organizationId));
  const proposal = proposedChange(search);
  // Planned at the detail's read time, so every detail refresh reads the plan again.
  const plans = useQuery({
    ...changePlanOptions(
      organizationId,
      query.data?.order.id ?? orderId,
      proposal,
      query.data?.asOf ?? null,
    ),
    enabled: Boolean(query.data),
  });
  const handoff = plans.data?.plans
    .flatMap((plan) => plan.steps)
    .find(
      (step) =>
        step.performer === 'luma' &&
        step.executable &&
        step.connectionId === search.edit,
    )?.handoff;
  const changeSearch = (next: Partial<OrdersSearch>) =>
    void navigate({
      to: '/app/$organizationId/orders/$orderId',
      params: { organizationId, orderId },
      search: { ...search, ...next },
      replace: true,
      ...(next.edit ? { hash: `source-${next.edit}` } : {}),
    });
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
      contextualAssistance
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
      messages={
        query.data ? (
          <RecordMessages
            organizationId={organizationId}
            kind="order"
            recordId={query.data.order.id}
            frame={(content) => (
              <OrderSection
                title={m.messaging_record_section_title()}
                icon={Mail}
              >
                {content}
              </OrderSection>
            )}
          />
        ) : null
      }
      returnCases={
        query.data ? (
          <OrderReturnCases
            organizationId={organizationId}
            orderId={query.data.order.id}
            sourceLabel={(connectionId) =>
              query.data.sources.find(
                (source) => source.connectionId === connectionId,
              )?.label ?? m.returns_source_fallback()
            }
          />
        ) : null
      }
      changePlan={
        query.data ? (
          <OrderChangePlanView
            plans={plans.data}
            loading={plans.isFetching}
            failed={plans.isError}
            sources={query.data.sources}
            locationNames={orderLocationNames(query.data)}
            authority={query.data.authority.lines?.connectionId ?? null}
            lines={planLines(query.data)}
            proposal={proposal}
            propose={(lineKey, quantity) =>
              changeSearch({
                changeLine: lineKey,
                changeQuantity: quantity,
                edit: undefined,
              })
            }
            clear={() =>
              changeSearch({
                changeLine: undefined,
                changeQuantity: undefined,
                edit: undefined,
              })
            }
            editAction={({ connectionId, handoff: target }) =>
              connectionId && target ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => changeSearch({ edit: connectionId })}
                >
                  {m.orders_plan_open_edit({
                    system:
                      query.data.sources.find(
                        (source) => source.connectionId === connectionId,
                      )?.label ?? m.orders_plan_any_system(),
                  })}
                </Button>
              ) : null
            }
          />
        ) : null
      }
      linkedSources={
        query.data ? (
          <>
            <RecordFields
              organizationId={organizationId}
              recordType="order"
              recordId={query.data.order.id}
            />
            <SalesRecord organizationId={organizationId} detail={query.data} />
            <NativeOrderStock
              organizationId={organizationId}
              detail={query.data}
            />
            <OrderIdentityLinks
              organizationId={organizationId}
              orderId={query.data.order.id}
            />
            <OrderLineIdentityLinks
              organizationId={organizationId}
              detail={query.data}
            />
          </>
        ) : null
      }
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
              ...(handoff &&
              search.edit === source.connectionId &&
              handoff.orderExternalId === source.externalId
                ? { change: { lines: handoff.lines } }
                : {}),
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
  contextualAssistance = false,
  organizationId,
  search,
  detail,
  loading = false,
  offline = false,
  error,
  refresh,
  sourceContext,
  linkedSources,
  messages,
  returnCases,
  changePlan,
}: {
  organizationId: string;
  /** The connected page supplies the authorized assistant control. */
  contextualAssistance?: boolean;
  search: OrdersSearch;
  detail?: OrderDetail | undefined;
  loading?: boolean;
  offline?: boolean;
  error?: OrderError | undefined;
  refresh: () => void;
  linkedSources?: ReactNode;
  /** Message threads linked to the order, framed as an order section. */
  messages?: ReactNode;
  /** The order's return cases and the control to open one. */
  returnCases?: ReactNode;
  /** The plan for a proposed or detected change, with its proposal control. */
  changePlan?: ReactNode;
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
    detail?.sources.find(
      (source) => source.connectionId === detail.authority.lines?.connectionId,
    ) ??
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
    <div className="order-page">
      {offline ? (
        <Alert role="status">{m.orders_detail_offline()}</Alert>
      ) : null}
      {error === 'missing' ? (
        <Alert role="alert">{m.orders_detail_missing()}</Alert>
      ) : error === 'access' ? (
        <Alert tone="danger" role="alert">
          {m.orders_access_lost()}
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {m.orders_detail_load_failed()}{' '}
          <Button variant="outline" onClick={refresh}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {detail && (detail.redirectedFrom || search.linkedFrom) ? (
        <Alert role="status">{m.orders_detail_linked_notice()}</Alert>
      ) : null}
      <OrderHeader
        contextualAssistance={contextualAssistance}
        organizationId={organizationId}
        search={listSearch}
        returnPath={returnPath}
        detail={detail}
      />
      {!detail ? (
        loading && !error ? (
          <p role="status" className="order-note">
            {m.orders_detail_loading()}
          </p>
        ) : null
      ) : (
        <div className="order-layout">
          <div className="order-main">
            <OrderSection
              title={m.orders_detail_state_title()}
              icon={ClipboardList}
            >
              <ul className="order-summary">
                {orderSummary(detail, (value) =>
                  formatWorkspaceDateTime(value, timeZone, 'day'),
                ).map(({ kind, text }) => {
                  const Icon = summaryIcons[kind];

                  return (
                    <li key={text} data-tone={summaryTones[kind]}>
                      <Icon aria-hidden="true" />
                      <span>{text}</span>
                    </li>
                  );
                })}
              </ul>
            </OrderSection>
            <OrderJourney
              detail={detail}
              organizationId={organizationId}
              from={here}
            />
            <OrderLines
              detail={detail}
              shown={shown}
              choose={setChosen}
              organizationId={organizationId}
              from={here}
            />
            <OrderCharges detail={detail} shown={shown} choose={setChosen} />
            {linkedSources}
            {detail.sources.length > 1 || detail.differences.length ? (
              <SourceComparison detail={detail} />
            ) : null}
            {changePlan}
            <OrderFulfillments
              detail={detail}
              organizationId={organizationId}
              from={here}
            />
            <OrderReturns
              detail={detail}
              organizationId={organizationId}
              from={here}
              cases={returnCases}
            />
            {messages}
            {contexts.map(({ source, content }) => (
              <div
                key={source.connectionId}
                id={`source-${source.connectionId}`}
                className="order-source-context"
              >
                <OrderSection
                  title={m.orders_detail_live_title({ source: source.label })}
                  icon={Radio}
                  description={m.orders_detail_live_description({
                    source: source.label,
                  })}
                >
                  {content}
                </OrderSection>
              </div>
            ))}
            <LumaActivity detail={detail} organizationId={organizationId} />
            <ObservedHistory detail={detail} />
          </div>
          <OrderInspector
            detail={detail}
            organizationId={organizationId}
            here={here}
          />
        </div>
      )}
    </div>
  );
}
