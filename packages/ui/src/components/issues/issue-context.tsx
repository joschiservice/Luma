import type { CaseSummary } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  GitBranch,
  Package,
  Receipt,
  RefreshCwOff,
  Truck,
  Unplug,
} from 'lucide-react';

import { issueKind, sourceLabel } from './case-presentation';

const icons: Record<string, typeof Package> = {
  inventory_mismatch: Package,
  sync_failure: Unplug,
  stuck_fulfillment: Truck,
  workflow_failure: GitBranch,
  order_quantity_mismatch: Receipt,
  stock_sync_stall: RefreshCwOff,
};

/** Displays the affected item, issue type, and source systems. */
export function IssueContext({
  item,
  compact = false,
}: {
  item: CaseSummary;
  compact?: boolean;
}) {
  const { label } = issueKind(item);
  const Icon = icons[item.class] ?? GitBranch;

  return (
    <div className="issue-context">
      <div className="issue-context-subject">
        <span>
          <Icon size={14} aria-hidden="true" />
          {label}
        </span>
        {!compact ? (
          <>
            <span aria-hidden="true">·</span>
            <strong>{item.subject.label ?? m.common_not_reported()}</strong>
          </>
        ) : null}
      </div>
      <div className="issue-context-sources">
        <span className="issue-context-divider" aria-hidden="true">
          ·
        </span>
        {item.sources.length
          ? item.sources.map(sourceLabel).join(' · ')
          : m.issues_source_system_unknown()}
      </div>
    </div>
  );
}
