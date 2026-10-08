import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from './button';

/**
 * Displays the current page and total pages with previous and next controls. `label` names the
 * navigation landmark, such as "Order pages". `formatTotal` names the total with its items, such
 * as `(count) => m.orders_count({ count })` for "340 orders", so the range reads "1–25 of 340
 * orders"; it fills the "of …" position, so languages that inflect nouns there (German "von 46
 * Problemen") phrase it accordingly. `emptyLabel` replaces the generic text shown when the page
 * is empty, such as "No orders". Omit `totalCount` when the source does not report a total; the
 * range and page number are then shown without one.
 */
export function Pagination({
  count,
  totalCount,
  offset,
  page,
  hasNext,
  onPrevious,
  onNext,
  disabled = false,
  pageSize = 25,
  formatTotal,
  emptyLabel,
  label,
}: {
  count: number;
  totalCount?: number | undefined;
  offset?: number | undefined;
  page?: number | undefined;
  pageSize?: number;
  hasNext: boolean;
  onPrevious?: (() => void) | undefined;
  onNext: () => void;
  disabled?: boolean;
  /** Formats the total with its localized item name, such as "340 orders". */
  formatTotal?: ((total: number) => string) | undefined;
  /** Shown when the page has no items, such as "No orders". */
  emptyLabel?: string | undefined;
  label?: string | undefined;
}) {
  const start = offset ?? (page ? (page - 1) * pageSize : 0);
  const currentPage = Math.floor(start / pageSize) + 1;
  const totalPages =
    totalCount === undefined
      ? undefined
      : Math.max(1, Math.ceil(totalCount / pageSize));
  const range = { start: start + 1, end: start + count };
  const total = (value: number) =>
    formatTotal ? formatTotal(value) : formatNumber(value);

  return (
    <nav
      data-slot="pagination"
      className="ui-pagination"
      aria-label={label ?? m.ui_pagination_label()}
    >
      <span role="status">
        {count === 0
          ? (emptyLabel ?? m.ui_pagination_empty())
          : totalCount === undefined
            ? m.ui_pagination_range(range)
            : m.ui_pagination_range_of_total({
                ...range,
                total: total(totalCount),
              })}
      </span>
      <div className="pagination-controls">
        <Button
          variant="outline"
          size="icon"
          aria-label={m.common_previous()}
          title={m.ui_pagination_previous_page()}
          disabled={disabled || !onPrevious}
          onClick={onPrevious}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span className="pagination-page" aria-live="polite">
          {totalPages === undefined
            ? rich(m.ui_pagination_page, {
                page: <strong>{formatNumber(currentPage)}</strong>,
              })
            : rich(m.ui_pagination_page_of_total, {
                page: (
                  <strong>
                    {formatNumber(Math.min(currentPage, totalPages))}
                  </strong>
                ),
                total: <strong>{formatNumber(totalPages)}</strong>,
              })}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label={m.common_next()}
          title={m.ui_pagination_next_page()}
          disabled={disabled || !hasNext}
          onClick={onNext}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
