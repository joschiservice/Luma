import './orders.css';

import type {
  OrderChangePlanQuery,
  OrderChangePlans,
  OrderDetail,
  OrderSourceFacts,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardContent } from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@luma/ui/components/primitives/dropdown-menu';
import { onlineManager, useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ClipboardList,
  Database,
  Ellipsis,
  Link2,
  Mail,
  Radio,
  Route as RouteIcon,
} from 'lucide-react';
import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';

import { appsOptions } from '../../kit/apps/data';
import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { RecordMessages } from '../../kit/record-messages';
import { OrderSection } from '../../shared/orders/order-section';
import { RecordFields } from '../adaptive/record-fields';
import { AppExtension } from '../apps/extension';
import { recordReturnPath } from '../records/data';
import { OrderReturnsWithCases } from '../returns/case-entry';
import { OrderReturns } from '../returns/order-returns';
import {
  OrderChangePlanContent,
  OrderChangeSummary,
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
import { OrderIdentityLinks, OrderLinkSuggestions } from './identity-links';
import { LineComparison } from './line-comparison';
import { OrderLineIdentityLinks } from './line-identity-links';
import { NativeOrderStock } from './native-stock';
import { OrderCharges } from './order-charges';
import { OrderHeader } from './order-header';
import { OrderInspector } from './order-inspector';
import { OrderFulfillments, OrderTimeline } from './order-timeline';
import { SalesRecordPanel, useSalesRecordAccess } from './sales-record';
import { OrderLines, SourceComparison, SourceSwitch } from './source-facts';
import { OrderSummaryList } from './summary';

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
  const salesAccess = useSalesRecordAccess(organizationId, query.data);
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
            frame={(content, empty) => (
              <OrderSection
                title={m.messaging_record_section_title()}
                icon={Mail}
                status={
                  empty ? <Badge>{m.orders_section_none()}</Badge> : undefined
                }
              >
                {empty ? null : content}
              </OrderSection>
            )}
          />
        ) : null
      }
      returns={(from) =>
        query.data ? (
          <OrderReturnsWithCases
            organizationId={organizationId}
            detail={query.data}
            from={from}
            sourceLabel={(connectionId) =>
              query.data.sources.find(
                (source) => source.connectionId === connectionId,
              )?.label ?? m.returns_source_fallback()
            }
          />
        ) : null
      }
      changePlan={{
        plans: plans.data,
        loading: plans.isFetching,
        failed: plans.isError,
        proposal,
        propose: (lineKey, quantity) =>
          changeSearch({
            changeLine: lineKey,
            changeQuantity: quantity,
            edit: undefined,
          }),
        clear: () =>
          changeSearch({
            changeLine: undefined,
            changeQuantity: undefined,
            edit: undefined,
          }),
        openEdit: (connectionId) => changeSearch({ edit: connectionId }),
        closeEdit: () => changeSearch({ edit: undefined }),
      }}
      workspace={
        query.data ? (
          <>
            <RecordFields
              organizationId={organizationId}
              recordType="order"
              recordId={query.data.order.id}
            />
            <NativeOrderStock
              organizationId={organizationId}
              detail={query.data}
            />
          </>
        ) : null
      }
      salesRecord={
        salesAccess && query.data
          ? () => (
              <SalesRecordPanel
                organizationId={organizationId}
                detail={query.data}
              />
            )
          : undefined
      }
      linkSuggestions={(open) =>
        query.data ? (
          <OrderLinkSuggestions
            organizationId={organizationId}
            orderId={query.data.order.id}
            open={open}
          />
        ) : null
      }
      links={(lineId) =>
        query.data ? (
          <>
            <OrderIdentityLinks
              organizationId={organizationId}
              orderId={query.data.order.id}
            />
            <OrderLineIdentityLinks
              organizationId={organizationId}
              detail={query.data}
              initialLineId={lineId}
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

/** The order's change plans with the reader's proposal and the hand-off to an app's edit. */
export interface OrderChangePlanState {
  plans: OrderChangePlans | undefined;
  loading: boolean;
  failed: boolean;
  proposal: OrderChangePlanQuery | null;
  propose: (lineKey: string, quantity: string) => void;
  clear: () => void;
  /** Opens the edit of the connection's app, prefilled from the plan's executable Luma step. */
  openEdit: (connectionId: string) => void;
  /** Leaves the app's edit, so reloading the order doesn't open it again. */
  closeEdit: () => void;
}

/** The panel open beside the order, with the line it was opened for. */
type Sheet =
  | { kind: 'plan'; line?: string | undefined }
  | { kind: 'links'; line?: string | undefined }
  | { kind: 'compare'; line: string }
  | { kind: 'sales' }
  | { kind: 'live'; connectionId: string };

function lineTitle(detail: OrderDetail, key: string) {
  const line = detail.sources
    .flatMap((source) => source.lines)
    .find((item) => item.comparisonKey === key || item.id === key);

  return line?.title ?? line?.skuCode ?? m.orders_lines_untitled();
}

/**
 * More order actions in the workspace bar: planning, source links, the Luma order record and
 * the raw records.
 */
function OrderMenu({
  organizationId,
  orderId,
  here,
  plan,
  links,
  sales,
  live,
}: {
  organizationId: string;
  orderId: string;
  here: string;
  plan?: (() => void) | undefined;
  links?: (() => void) | undefined;
  sales?: (() => void) | undefined;
  /** Each source whose app shows live details, with the action that opens them. */
  live: { connectionId: string; label: string; open: () => void }[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={m.orders_detail_more_actions()}
            title={m.orders_detail_more_actions()}
          >
            <Ellipsis aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-auto min-w-60">
        {plan ? (
          <DropdownMenuItem onClick={plan}>
            <RouteIcon aria-hidden="true" />
            {m.orders_lines_action_plan()}
          </DropdownMenuItem>
        ) : null}
        {links ? (
          <DropdownMenuItem onClick={links}>
            <Link2 aria-hidden="true" />
            {m.orders_links_title()}
          </DropdownMenuItem>
        ) : null}
        {sales ? (
          <DropdownMenuItem onClick={sales}>
            <ClipboardList aria-hidden="true" />
            {m.orders_sales_title()}
          </DropdownMenuItem>
        ) : null}
        {live.map((item) => (
          <DropdownMenuItem key={item.connectionId} onClick={item.open}>
            <Radio aria-hidden="true" />
            {m.orders_detail_live_title({ source: item.label })}
          </DropdownMenuItem>
        ))}
        {plan || links || sales || live.length ? (
          <DropdownMenuSeparator />
        ) : null}
        <DropdownMenuItem
          render={
            <Link
              to="/app/$organizationId/records/$kind/$recordId"
              params={{ organizationId, kind: 'order', recordId: orderId }}
              search={{ from: here }}
            />
          }
        >
          <Database aria-hidden="true" />
          {m.orders_inspector_open_records()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Presents one order: its state, lines with their changes, fulfillment, charges, how sources
 * compare, linked work and history, with its unavailable states. Plans, source links and a
 * line's comparison open in a panel beside the order.
 */
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
  workspace,
  links,
  linkSuggestions,
  messages,
  returns,
  changePlan,
  salesRecord,
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
  /** Workspace fields and Luma-owned records and stock for the order. */
  workspace?: ReactNode;
  /** The order's source links and line matches, opened with a line chosen. */
  links?: ((lineId: string | undefined) => ReactNode) | undefined;
  /** Suggested source links, with a control that calls `open` to review them. */
  linkSuggestions?: ((open: () => void) => ReactNode) | undefined;
  /** Message threads linked to the order, framed as an order section. */
  messages?: ReactNode;
  /** The order's returns with its return cases and the control to open one. */
  returns?: ((from: string) => ReactNode) | undefined;
  /** Change plans for detected changes and the reader's proposal. */
  changePlan?: OrderChangePlanState | undefined;
  /** Accepts the order into Luma or edits its Luma order record; absent without access. */
  salesRecord?: (() => ReactNode) | undefined;
  sourceContext?: (source: OrderSourceFacts) => ReactNode;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  // A link to an app's edit opens that app's live details; a link with a proposal opens its plan.
  const [sheet, setSheet] = useState<Sheet | null>(() =>
    search.edit
      ? { kind: 'live', connectionId: search.edit }
      : changePlan?.proposal
        ? { kind: 'plan' }
        : null,
  );
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
  const liveContext =
    sheet?.kind === 'live'
      ? contexts.find(
          ({ source }) => source.connectionId === sheet.connectionId,
        )
      : undefined;
  const several = (detail?.sources.length ?? 0) > 1;
  const plannable = detail && changePlan ? planLines(detail) : [];
  const sourceLabel = (connectionId: string) =>
    detail?.sources.find((source) => source.connectionId === connectionId)
      ?.label ?? m.orders_plan_any_system();

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
        menu={
          detail ? (
            <OrderMenu
              organizationId={organizationId}
              orderId={detail.order.id}
              here={here}
              plan={
                plannable.length ? () => setSheet({ kind: 'plan' }) : undefined
              }
              links={links ? () => setSheet({ kind: 'links' }) : undefined}
              sales={
                salesRecord ? () => setSheet({ kind: 'sales' }) : undefined
              }
              live={contexts.map(({ source }) => ({
                connectionId: source.connectionId,
                label: source.label,
                open: () =>
                  setSheet({ kind: 'live', connectionId: source.connectionId }),
              }))}
            />
          ) : null
        }
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
            <Card
              as="section"
              variant="subtle"
              aria-label={m.orders_detail_state_title()}
            >
              <CardContent>
                <OrderSummaryList detail={detail} />
              </CardContent>
            </Card>
            <SourceSwitch detail={detail} shown={shown} choose={setChosen} />
            <OrderLines
              detail={detail}
              shown={shown}
              organizationId={organizationId}
              from={here}
              actions={{
                plan: plannable.length
                  ? (line) => setSheet({ kind: 'plan', line })
                  : undefined,
                compare: several
                  ? (line) => setSheet({ kind: 'compare', line })
                  : undefined,
                match:
                  several && links
                    ? (line) => setSheet({ kind: 'links', line })
                    : undefined,
              }}
              footer={
                changePlan ? (
                  <OrderChangeSummary
                    plans={changePlan.plans}
                    failed={changePlan.failed}
                    locationNames={orderLocationNames(detail)}
                    review={() => setSheet({ kind: 'plan' })}
                  />
                ) : null
              }
            />
            <OrderFulfillments
              detail={detail}
              organizationId={organizationId}
              from={here}
            />
            {returns ? (
              returns(here)
            ) : (
              <OrderReturns
                detail={detail}
                organizationId={organizationId}
                from={here}
              />
            )}
            <OrderCharges detail={detail} shown={shown} />
            {several || detail.differences.length ? (
              <SourceComparison detail={detail} />
            ) : null}
            {workspace}
            {messages}
            <OrderTimeline
              detail={detail}
              organizationId={organizationId}
              from={here}
            />
          </div>
          <OrderInspector
            detail={detail}
            organizationId={organizationId}
            here={here}
            manageLinks={links ? () => setSheet({ kind: 'links' }) : undefined}
            linkSuggestions={
              links && linkSuggestions
                ? linkSuggestions(() => setSheet({ kind: 'links' }))
                : null
            }
          />
        </div>
      )}
      {detail ? (
        <Dialog
          // Live details open once the source's app has loaded them.
          open={sheet !== null && (sheet.kind !== 'live' || !!liveContext)}
          onOpenChange={(open) => {
            if (open) return;
            if (sheet?.kind === 'live' && search.edit) changePlan?.closeEdit();
            setSheet(null);
          }}
        >
          <DialogContent placement="sheet" className="order-sheet">
            {sheet?.kind === 'plan' && changePlan ? (
              <>
                <DialogHeader>
                  <DialogTitle>{m.orders_plan_title()}</DialogTitle>
                  <DialogDescription>
                    {m.orders_plan_description()}
                  </DialogDescription>
                </DialogHeader>
                <OrderChangePlanContent
                  plans={changePlan.plans}
                  loading={changePlan.loading}
                  failed={changePlan.failed}
                  sources={detail.sources}
                  locationNames={orderLocationNames(detail)}
                  authority={detail.authority.lines?.connectionId ?? null}
                  lines={plannable}
                  initialLine={sheet.line}
                  proposal={changePlan.proposal}
                  propose={changePlan.propose}
                  clear={changePlan.clear}
                  editAction={({ connectionId, handoff }) =>
                    connectionId && handoff ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSheet({ kind: 'live', connectionId });
                          changePlan.openEdit(connectionId);
                        }}
                      >
                        {m.orders_plan_open_edit({
                          system: sourceLabel(connectionId),
                        })}
                      </Button>
                    ) : null
                  }
                />
              </>
            ) : sheet?.kind === 'links' && links ? (
              <>
                <DialogHeader>
                  <DialogTitle>{m.orders_links_title()}</DialogTitle>
                  <DialogDescription>
                    {m.orders_links_description()}
                  </DialogDescription>
                </DialogHeader>
                <div className="order-sheet-body">{links(sheet.line)}</div>
              </>
            ) : sheet?.kind === 'live' && liveContext ? (
              <>
                <DialogHeader>
                  <DialogTitle>
                    {m.orders_detail_live_title({
                      source: liveContext.source.label,
                    })}
                  </DialogTitle>
                  <DialogDescription>
                    {m.orders_detail_live_description({
                      source: liveContext.source.label,
                    })}
                  </DialogDescription>
                </DialogHeader>
                <div
                  id={`source-${liveContext.source.connectionId}`}
                  className="order-sheet-body"
                >
                  {liveContext.content}
                </div>
              </>
            ) : sheet?.kind === 'sales' && salesRecord ? (
              <>
                <DialogHeader>
                  <DialogTitle>{m.orders_sales_title()}</DialogTitle>
                  <DialogDescription>
                    {m.orders_sales_description()}
                  </DialogDescription>
                </DialogHeader>
                <div className="order-sheet-body">{salesRecord()}</div>
              </>
            ) : sheet?.kind === 'compare' ? (
              <>
                <DialogHeader>
                  <DialogTitle>
                    {m.orders_compare_line_title({
                      item: lineTitle(detail, sheet.line),
                    })}
                  </DialogTitle>
                  <DialogDescription>
                    {m.orders_compare_line_description()}
                  </DialogDescription>
                </DialogHeader>
                <LineComparison detail={detail} only={sheet.line} />
              </>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
