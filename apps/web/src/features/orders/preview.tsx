import type { OrderListItem } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { issueKind } from '@luma/ui/components/issues/case-presentation';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@luma/ui/components/primitives/dropdown-menu';
import { StatePill } from '@luma/ui/components/primitives/state';
import type { CellFilterValue } from '@luma/ui/lib/collection-conditions';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, ListFilter } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  formatQuantity,
  issueStateLabel,
} from '../../shared/orders/presentation';
import { ordersPresentation } from './collection';
import { orderOptions } from './data';
import { orderField, OrderFlags } from './fields';
import { OrderSummaryList } from './summary';

/** Narrows the list to a value shown in the preview, or excludes it. */
export type OrderValueFilter = (
  field: string,
  value: CellFilterValue,
  exclude: boolean,
) => void;

/** Lines the preview lists before pointing to the full order. */
const previewLines = 5;

function FilterMenu({
  field,
  value,
  label,
  filter,
}: {
  field: string;
  value: CellFilterValue;
  label: string;
  filter: OrderValueFilter;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="order-preview-filter"
            aria-label={m.orders_preview_filter({ value: label })}
            title={m.orders_preview_filter({ value: label })}
          >
            <ListFilter aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        <DropdownMenuItem onClick={() => filter(field, value, false)}>
          {m.collections_filter_to_value()}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => filter(field, value, true)}>
          {m.collections_exclude_value()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Fact({
  label,
  children,
  menu,
}: {
  label: string;
  children: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <div className="order-preview-fact">
      <dt>{label}</dt>
      <dd>
        <span>{children}</span>
        {menu}
      </dd>
    </div>
  );
}

const label = (key: string) => ordersPresentation[key]?.label() ?? key;

/**
 * A compact summary of the order open beside the list: its attention flags and key facts from
 * the list row, then the current-state sentences, first lines with their remaining units and
 * open issues from the order's detail read. A failed refresh keeps the details already read.
 * `filter` offers "Show only this value" and "Hide this value" on status, payment, fulfillment
 * and each source.
 */
export function OrderPreview({
  organizationId,
  order,
  orderId,
  filter,
}: {
  organizationId: string;
  /** The order's list row, when it is on the current page. */
  order: OrderListItem | undefined;
  orderId: string;
  filter?: OrderValueFilter | undefined;
}) {
  const detail = useQuery(orderOptions(organizationId, orderId));
  const shown = order ?? detail.data?.order;
  const source =
    detail.data?.sources.find((item) => item.selected) ??
    detail.data?.sources[0];
  // Issues still open on the order, the ones that need the reader first.
  const openIssues = (detail.data?.issues ?? [])
    .filter((issue) => issue.state !== 'resolved')
    .sort((left, right) => Number(right.needsYou) - Number(left.needsYou));
  const menu = (field: string, value: string, text: string) =>
    filter ? (
      <FilterMenu field={field} value={value} label={text} filter={filter} />
    ) : null;

  return (
    <div className="order-preview">
      {shown ? (
        <>
          <OrderFlags order={shown} />
          <dl className="order-preview-facts">
            {(['status', 'paymentStatus', 'fulfillment'] as const).map(
              (key) => {
                const text = String(orderField(shown, key));

                return (
                  <Fact
                    key={key}
                    label={label(key)}
                    menu={menu(key, shown[key], text)}
                  >
                    {text}
                  </Fact>
                );
              },
            )}
            {(['total', 'placed', 'due', 'updated', 'channel'] as const).map(
              (key) => (
                <Fact key={key} label={label(key)}>
                  {orderField(shown, key)}
                </Fact>
              ),
            )}
            <Fact label={label('sources')}>
              <span className="order-preview-sources">
                {shown.sources.map((item) => (
                  <span key={item.connectionId}>
                    {item.label}
                    {menu('source', item.connectionId, item.label)}
                  </span>
                ))}
              </span>
            </Fact>
          </dl>
        </>
      ) : null}
      {detail.data ? (
        <>
          <OrderSummaryList detail={detail.data} />
          {source?.lines.length ? (
            <section>
              <h3 className="order-preview-heading">
                {m.orders_preview_lines()}
              </h3>
              <ul className="order-preview-lines">
                {source.lines.slice(0, previewLines).map((line) => (
                  <li key={line.id}>
                    <span>
                      {line.title ?? line.skuCode ?? m.common_empty_value()}
                    </span>
                    <span className="order-preview-quantity">
                      {formatQuantity(
                        line.currentQuantity ?? line.quantity,
                        line.unit,
                      )}
                      {line.remainingQuantity !== null &&
                      Number(line.remainingQuantity) > 0 ? (
                        <small>
                          {m.orders_preview_line_remaining({
                            quantity: formatQuantity(
                              line.remainingQuantity,
                              line.unit,
                            ),
                          })}
                        </small>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              {source.lines.length > previewLines ? (
                <p className="order-note">
                  {m.common_count_more({
                    count: source.lines.length - previewLines,
                  })}
                </p>
              ) : null}
            </section>
          ) : null}
          {openIssues.length ? (
            <section>
              <h3 className="order-preview-heading">
                {m.orders_inspector_issues()}
              </h3>
              <ul className="order-list">
                {openIssues.map((issue) => (
                  <li key={issue.id}>
                    <Link
                      className="order-row-link"
                      to="/app/$organizationId/exceptions/$exceptionId"
                      params={{ organizationId, exceptionId: issue.id }}
                      search={{ view: issue.needsYou ? 'needs_you' : 'active' }}
                    >
                      <span className="orders-cell-stack">
                        <strong>{issueKind(issue).label}</strong>
                        <small>{issueStateLabel(issue.state)}</small>
                      </span>
                      {issue.needsYou ? (
                        <StatePill state="attention">
                          {m.orders_flag_needs_you()}
                        </StatePill>
                      ) : null}
                      <ChevronRight
                        className="order-row-chevron"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {detail.isError ? (
            <p role="status" className="order-note">
              {m.orders_preview_stale()}
            </p>
          ) : null}
        </>
      ) : detail.isPending ? (
        <p role="status" className="order-note">
          {m.orders_detail_loading()}
        </p>
      ) : detail.isError ? (
        <Alert role="status">{m.orders_preview_unavailable()}</Alert>
      ) : null}
    </div>
  );
}
