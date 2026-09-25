import type { CaseSummary } from '@luma/api-contract';
import { GitBranch, Package, Truck, Unplug } from 'lucide-react';

/** Displays the affected item, issue type, and source systems. */
export function IssueContext({ item }: { item: CaseSummary }) {
  const types: Record<string, { label: string; Icon: typeof Package }> = {
    inventory_mismatch: { label: 'Inventory mismatch', Icon: Package },
    sync_failure: { label: 'Connection issue', Icon: Unplug },
    stuck_fulfillment: { label: 'Fulfillment delay', Icon: Truck },
    workflow_failure: { label: 'Workflow issue', Icon: GitBranch },
  };
  const { label, Icon } = types[item.class] ?? {
    label: 'Operational issue',
    Icon: GitBranch,
  };

  return (
    <div className="issue-context">
      <div className="issue-context-subject">
        <span>
          <Icon size={14} aria-hidden="true" />
          {label}
        </span>
        <span aria-hidden="true">·</span>
        <strong title={item.subject.id}>{item.subject.id}</strong>
      </div>
      <div className="issue-context-sources">
        <span className="issue-context-divider" aria-hidden="true">
          ·
        </span>
        {item.sources.length
          ? item.sources.join(' · ')
          : 'Source system unknown'}
      </div>
    </div>
  );
}
