import type { CaseSummary } from '@luma/api-contract';
import type { ReactNode } from 'react';

import { StatePill } from '../primitives/state';
import { issueStatus, severityFullLabel } from './case-presentation';
import { IssuePanelClose } from './issue-panel-close';
import { IssuePanelHeading } from './issue-panel-heading';

/**
 * Shows the issue's operational status, including why it needs attention, and its severity.
 * The inspector and the full issue page share it so both headers report the same state.
 */
export function IssueStatusBadges({ item }: { item: CaseSummary }) {
  const status = issueStatus(item);

  return (
    <>
      <StatePill state={status.state}>{status.label}</StatePill>
      <span className="issue-severity" data-severity={item.severity}>
        {severityFullLabel(item.severity)}
      </span>
    </>
  );
}

/**
 * Keeps issue identity and navigation in a compact row, with dismissal at the end of the
 * controls. `owner` sits beside the status and severity as the issue's responsible person.
 */
export function IssueInspectorHeader({
  item,
  fallback,
  onClose,
  next,
  openPage,
  refresh,
  owner,
  className = '',
}: {
  item?: CaseSummary | undefined;
  fallback?: string | undefined;
  onClose: () => void;
  next?: ReactNode;
  openPage?: ReactNode;
  refresh?: ReactNode;
  owner?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`issue-inspector-header ${className}`}>
      <div className="issue-panel-identity">
        <IssuePanelHeading item={item} {...(fallback ? { fallback } : {})} />
        {item ? (
          <div className="issue-panel-status">
            <IssueStatusBadges item={item} />
            {owner}
          </div>
        ) : null}
      </div>
      <div className="issue-panel-navigation">
        {refresh}
        {next}
        {openPage}
        <IssuePanelClose onClose={onClose} />
      </div>
    </header>
  );
}
