import type { OrderDetail } from '@luma/api-contract';
import {
  formatWorkspaceDateTime,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import {
  CircleCheck,
  CircleHelp,
  Clock,
  GitCompareArrows,
  Inbox,
  Info,
  type LucideIcon,
  PackageOpen,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useContext } from 'react';

import {
  orderSummary,
  type SummaryKind,
} from '../../shared/orders/presentation';

const summaryIcons: Record<SummaryKind, LucideIcon> = {
  state: Info,
  removed: Trash2,
  closed: CircleCheck,
  remaining: PackageOpen,
  unknown: CircleHelp,
  overdue: Clock,
  failed: TriangleAlert,
  issues: Inbox,
  differs: GitCompareArrows,
};

const summaryTones: Record<
  SummaryKind,
  'neutral' | 'warning' | 'danger' | 'success'
> = {
  state: 'neutral',
  removed: 'warning',
  closed: 'success',
  remaining: 'neutral',
  unknown: 'warning',
  overdue: 'danger',
  failed: 'danger',
  issues: 'warning',
  differs: 'warning',
};

/** The order's current state in short sentences, each with an icon and tone for its kind. */
export function OrderSummaryList({
  detail,
}: {
  detail: Pick<
    OrderDetail,
    'order' | 'sources' | 'differences' | 'fulfillments' | 'issues'
  >;
}) {
  const timeZone = useContext(WorkspaceTimezone);

  return (
    <ul className="order-summary">
      {orderSummary(detail, (value) =>
        formatWorkspaceDateTime(value, timeZone, 'day'),
      ).map(({ kind, text }) => {
        const Icon = summaryIcons[kind];

        return (
          <li key={text} data-tone={summaryTones[kind]}>
            <Icon aria-hidden="true" />
            <span>{text}</span>
          </li>
        );
      })}
    </ul>
  );
}
