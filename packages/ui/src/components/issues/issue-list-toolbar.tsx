import { caseClasses, type CaseQuery, caseStates } from '@luma/api-contract';
import { CircleDot, Flag, Shapes } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  type CollectionFilter,
  CollectionToolbar,
} from '../primitives/collection-toolbar';
import { caseLabel } from './case-investigation';

type Filters = Pick<CaseQuery, 'state' | 'class' | 'severity'>;

const severities = ['high', 'medium'] as const;

const options = (values: readonly string[]) =>
  values.map((value) => ({ value, label: caseLabel(value) }));

/** Presents issue views and editable filter chips through the shared collection toolbar. */
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
  return (
    <CollectionToolbar
      className="inbox-toolbar"
      views={views}
      filters={
        [
          {
            kind: 'choice',
            key: 'severity',
            label: 'Severity',
            icon: Flag,
            value: filters.severity,
            options: options(severities),
            onChange: (value) =>
              onFiltersChange({
                severity: severities.find((item) => item === value),
              }),
          },
          {
            kind: 'choice',
            key: 'class',
            label: 'Issue type',
            icon: Shapes,
            value: filters.class,
            options: options(caseClasses),
            onChange: (value) =>
              onFiltersChange({
                class: caseClasses.find((item) => item === value),
              }),
          },
          {
            kind: 'choice',
            key: 'state',
            label: 'State',
            icon: CircleDot,
            value: filters.state,
            options: options(caseStates),
            onChange: (value) =>
              onFiltersChange({
                state: caseStates.find((item) => item === value),
              }),
          },
        ] satisfies CollectionFilter[]
      }
      onClear={() =>
        onFiltersChange({
          state: undefined,
          class: undefined,
          severity: undefined,
        })
      }
      onRefresh={onRefresh}
      refreshing={refreshing}
      refreshLabel="Refresh issues"
    />
  );
}
