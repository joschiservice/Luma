import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from './button';

/** Displays the current page and total pages with previous and next controls. */
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
}) {
  const start = offset ?? (page ? (page - 1) * pageSize : 0);
  const currentPage = Math.floor(start / pageSize) + 1;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <nav className="issue-pagination" aria-label="Issue pages">
      <span role="status">
        {count === 0
          ? 'No issues'
          : `${start + 1}–${start + count} of ${totalCount} issues`}
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
          <strong>{totalPages}</strong>
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
