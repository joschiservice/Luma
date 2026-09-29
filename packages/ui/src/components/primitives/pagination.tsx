import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from './button';

/**
 * Displays the current page and total pages with previous and next controls. `itemLabel` names
 * the plural items in the range text, such as "orders", and `label` names the navigation
 * landmark, such as "Order pages". Omit `totalCount` when the source does not report a total;
 * the range and page number are then shown without one.
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
  itemLabel = 'items',
  label = 'Pages',
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
  itemLabel?: string;
  label?: string;
}) {
  const start = offset ?? (page ? (page - 1) * pageSize : 0);
  const currentPage = Math.floor(start / pageSize) + 1;
  const totalPages =
    totalCount === undefined
      ? undefined
      : Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <nav data-slot="pagination" className="ui-pagination" aria-label={label}>
      <span role="status">
        {count === 0
          ? `No ${itemLabel}`
          : totalCount === undefined
            ? `${start + 1}–${start + count} ${itemLabel}`
            : `${start + 1}–${start + count} of ${totalCount.toLocaleString()} ${itemLabel}`}
      </span>
      <div className="pagination-controls">
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous"
          title="Previous page"
          disabled={disabled || !onPrevious}
          onClick={onPrevious}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span className="pagination-page" aria-live="polite">
          {totalPages === undefined ? (
            <>
              Page <strong>{currentPage.toLocaleString()}</strong>
            </>
          ) : (
            <>
              Page <strong>{Math.min(currentPage, totalPages)}</strong> of{' '}
              <strong>{totalPages.toLocaleString()}</strong>
            </>
          )}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next"
          title="Next page"
          disabled={disabled || !hasNext}
          onClick={onNext}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
