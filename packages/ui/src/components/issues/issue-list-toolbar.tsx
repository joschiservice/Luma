import { caseClasses, type CaseQuery, caseStates } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { CircleDot, Flag, Shapes } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  type CollectionFilter,
  CollectionToolbar,
} from '../primitives/collection-toolbar';
import { caseStateLabel, issueKind, severityLabel } from './case-presentation';

type Filters = Pick<CaseQuery, 'state' | 'class' | 'severity'>;

const severities = ['high', 'medium'] as const;

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
            label: m.issues_filter_severity(),
            icon: Flag,
            value: filters.severity,
            options: severities.map((value) => ({
              value,
              label: severityLabel(value),
            })),
            onChange: (value) =>
              onFiltersChange({
                severity: severities.find((item) => item === value),
              }),
          },
          {
            kind: 'choice',
            key: 'class',
            label: m.issues_filter_type(),
            icon: Shapes,
            value: filters.class,
            options: caseClasses.map((value) => ({
              value,
              label: issueKind({ class: value }).label,
            })),
            onChange: (value) =>
              onFiltersChange({
                class: caseClasses.find((item) => item === value),
              }),
          },
          {
            kind: 'choice',
            key: 'state',
            label: m.common_status(),
            icon: CircleDot,
            value: filters.state,
            options: caseStates.map((value) => ({
              value,
              label: caseStateLabel(value),
            })),
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
      refreshLabel={m.issues_refresh_issues()}
    />
  );
}
