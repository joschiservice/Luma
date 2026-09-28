import type { CaseSummary } from '@luma/api-contract';

import type { Domain } from '../primitives/domain-icon';
import type { OperationalState } from '../primitives/state';

type IssueKind = { label: string; domain: Domain };

const kinds: Record<string, IssueKind> = {
  inventory_mismatch: { label: 'Stock mismatch', domain: 'inventory' },
  sync_failure: { label: 'Connection issue', domain: 'apps' },
  stuck_fulfillment: { label: 'Fulfillment delay', domain: 'fulfillment' },
  workflow_failure: { label: 'Workflow issue', domain: 'workflows' },
};

const sources: Record<string, string> = {
  shopify: 'Shopify',
  jtl: 'JTL',
  'jtl-onprem': 'JTL-Wawi',
  'jtl-cloud': 'JTL Cloud',
};

/** Describes what kind of problem an issue is, with its domain landmark. */
export function issueKind(item: Pick<CaseSummary, 'class'>): IssueKind {
  return kinds[item.class] ?? { label: 'Operational issue', domain: 'issues' };
}

/** Names a source system as people know it, such as `jtl-cloud` → JTL Cloud. */
export function sourceLabel(source: string) {
  return (
    sources[source] ??
    source.replaceAll(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase())
  );
}

/**
 * Summarizes where an issue stands for lists and Home: whether it needs a person,
 * what Luma is doing, or how it ended. Verified means the outcome was observed.
 */
export function issueStatus(
  item: Pick<
    CaseSummary,
    'state' | 'attention' | 'resolution' | 'diagnosisStatus'
  >,
): { state: OperationalState; label: string } {
  if (item.state === 'resolved')
    return item.resolution === 'verified'
      ? { state: 'verified', label: 'Verified' }
      : { state: 'idle', label: 'Closed' };
  if (item.attention.required)
    return item.attention.reason === 'approval'
      ? { state: 'approval', label: 'Needs approval' }
      : item.attention.reason === 'manual_intervention'
        ? { state: 'attention', label: 'Needs your action' }
        : { state: 'attention', label: 'Needs review' };
  switch (item.state) {
    case 'failed':
      return { state: 'error', label: 'Action failed' };
    case 'escalated':
      return { state: 'attention', label: 'Needs review' };
    case 'executing':
      return { state: 'running', label: 'Applying fix' };
    case 'verifying':
      return { state: 'running', label: 'Checking result' };
    case 'allowed':
      return { state: 'running', label: 'Ready to apply' };
    case 'awaiting_approval':
      return { state: 'approval', label: 'Needs approval' };
    case 'proposed':
      return { state: 'waiting', label: 'Fix proposed' };
    case 'diagnosed':
      return { state: 'waiting', label: 'Investigation ready' };
    default:
      return item.diagnosisStatus === 'failed'
        ? { state: 'error', label: 'Investigation failed' }
        : item.diagnosisStatus === 'insufficient_evidence'
          ? { state: 'attention', label: 'Needs more evidence' }
          : { state: 'running', label: 'Investigating' };
  }
}

/** Formats elapsed time compactly, such as 45s, 12m, 3h or 2d. */
export function elapsed(from: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;

  return `${Math.floor(seconds / 86400)}d`;
}
