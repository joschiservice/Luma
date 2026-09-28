import type { CaseSummary } from '@luma/api-contract';
import type { ReactNode } from 'react';

import { StatePill } from '../primitives/state';
import { issueStatus } from './case-presentation';
import { IssuePanelClose } from './issue-panel-close';
import { IssuePanelHeading } from './issue-panel-heading';

/** Keeps issue identity and navigation in a compact row, with dismissal at the end of the controls. */
export function IssueInspectorHeader({
  item,
  fallback,
  onClose,
  next,
  openPage,
  refresh,
  className = '',
}: {
  item?: CaseSummary | undefined;
  fallback?: string | undefined;
  onClose: () => void;
  next?: ReactNode;
  openPage?: ReactNode;
  refresh?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`issue-inspector-header ${className}`}>
      <div className="issue-panel-identity">
        <IssuePanelHeading item={item} {...(fallback ? { fallback } : {})} />
        {item ? (
          <div className="issue-panel-status">
            <StatePill state={issueStatus(item).state}>
              {issueStatus(item).label}
            </StatePill>
            <span className="issue-severity" data-severity={item.severity}>
              {item.severity === 'high' ? 'High' : 'Medium'} severity
            </span>
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
