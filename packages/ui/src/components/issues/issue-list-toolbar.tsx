import { caseClasses, type CaseQuery, caseStates } from '@luma/api-contract';
import { RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '../primitives/button';
import { Disclosure } from '../primitives/disclosure';
import { Select } from '../primitives/select';
import { caseLabel } from './case-investigation';

type Filters = Pick<CaseQuery, 'state' | 'class' | 'severity'>;

/** Groups issue views, refresh, and removable filters without owning routing or data fetching. */
export function IssueListToolbar({
  views,
  filters,
  onFiltersChange,
  onRefresh,
  refreshing = false,
}: {
  views: ReactNode;
  filters: Filters;
  onFiltersChange: (patch: Partial<Filters>) => void;
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  const count = [filters.class, filters.state, filters.severity].filter(
    Boolean,
  ).length;
  const labels = { state: 'State', class: 'Issue type', severity: 'Severity' };

  return (
    <div className="inbox-toolbar">
      <nav className="inbox-views" aria-label="Issue views">
        {views}
        <Button variant="ghost" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw size={14} aria-hidden="true" />
          Refresh
        </Button>
      </nav>
      <Disclosure className="inbox-filter-disclosure">
        <summary>
          <SlidersHorizontal size={13} aria-hidden="true" /> Filters
          {count ? ` · ${count} active` : ''}
        </summary>
        <div className="inbox-filters">
          {(['state', 'class', 'severity'] as const).map((field) => (
            <label key={field}>
              {labels[field]}
              <Select
                aria-label={labels[field]}
                value={filters[field] ?? ''}
                onValueChange={(value) =>
                  onFiltersChange({ [field]: value || undefined })
                }
                options={[
                  {
                    value: '',
                    label: `All ${field === 'class' ? 'types' : field === 'state' ? 'states' : 'severities'}`,
                  },
                  ...(field === 'state'
                    ? caseStates
                    : field === 'class'
                      ? caseClasses
                      : ['high', 'medium']
                  ).map((value) => ({ value, label: caseLabel(value) })),
                ]}
              />
            </label>
          ))}
        </div>
      </Disclosure>
      {count ? (
        <div className="inbox-active-filters" aria-label="Active filters">
          {(['state', 'class', 'severity'] as const).map((field) =>
            filters[field] ? (
              <Button
                key={field}
                variant="outline"
                onClick={() => onFiltersChange({ [field]: undefined })}
                aria-label={`Remove ${labels[field]} filter: ${caseLabel(filters[field]!)}`}
              >
                {caseLabel(filters[field]!)}
                <X size={12} aria-hidden="true" />
              </Button>
            ) : null,
          )}
          <Button
            variant="ghost"
            onClick={() =>
              onFiltersChange({
                state: undefined,
                class: undefined,
                severity: undefined,
              })
            }
          >
            Clear filters
          </Button>
        </div>
      ) : null}
    </div>
  );
}
