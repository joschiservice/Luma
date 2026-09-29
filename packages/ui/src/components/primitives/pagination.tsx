import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from './button';

/**
 * Displays the current page and total pages with previous and next controls. `itemLabel` names
 * the plural items in the range text and `label` names the navigation landmark.
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
  itemLabel = 'issues',
  label = 'Issue pages',
}: {
  count: number;
  totalCount: number;
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
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <nav className="issue-pagination" aria-label={label}>
      <span role="status">
        {count === 0
          ? `No ${itemLabel}`
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
          Page <strong>{Math.min(currentPage, totalPages)}</strong> of{' '}
          <strong>{totalPages.toLocaleString()}</strong>
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
