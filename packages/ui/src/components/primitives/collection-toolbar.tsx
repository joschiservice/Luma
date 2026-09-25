import { RefreshCw, X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';

import { Button } from './button';

/** Groups collection views, search controls, and removable filters without owning filter state. */
export function CollectionToolbar({
  views,
  children,
  filters = [],
  onClear,
  onRefresh,
  refreshing = false,
  refreshLabel = 'Refresh',
}: {
  views: ReactNode;
  children: ReactNode;
  filters?: { key: string; label: string; onRemove: () => void }[];
  onClear?: () => void;
  onRefresh: () => void;
  refreshing?: boolean | undefined;
  refreshLabel?: string;
}) {
  const root = useRef<HTMLDivElement>(null);

  function changeFilter(change: () => void) {
    change();
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(
          '.collection-toolbar-controls input, .collection-toolbar-controls [role="combobox"]',
        )
        ?.focus(),
    );
  }

  return (
    <div className="collection-toolbar" ref={root}>
      <div className="collection-toolbar-views">
        {views}
        <Button
          variant="ghost"
          aria-label={refreshLabel}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw
            aria-hidden="true"
            className={
              refreshing ? 'animate-spin motion-reduce:animate-none' : ''
            }
          />
          Refresh
        </Button>
      </div>
      <div className="collection-toolbar-controls">{children}</div>
      {filters.length > 0 ? (
        <div className="collection-toolbar-filters" aria-label="Active filters">
          {filters.map((filter) => (
            <Button
              key={filter.key}
              variant="outline"
              onClick={() => changeFilter(filter.onRemove)}
              aria-label={`Remove ${filter.label} filter`}
            >
              {filter.label}
              <X aria-hidden="true" />
            </Button>
          ))}
          {onClear ? (
            <Button variant="ghost" onClick={() => changeFilter(onClear)}>
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
