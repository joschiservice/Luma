import type { CaseSummary } from '@luma/api-contract';
import type { ReactNode } from 'react';

import { IssuePanelClose } from './issue-panel-close';
import { IssuePanelHeading } from './issue-panel-heading';

/** Keeps the issue title, severity, context, and navigation visible while scrolling. */
export function IssueInspectorHeader({
  item,
  fallback,
  onClose,
  next,
  openPage,
  className = '',
}: {
  item?: CaseSummary | undefined;
  fallback?: string | undefined;
  onClose: () => void;
  next?: ReactNode;
  openPage?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`issue-inspector-header ${className}`}>
      <IssuePanelClose onClose={onClose} />
      <IssuePanelHeading item={item} {...(fallback ? { fallback } : {})} />
      {openPage || next ? (
        <div className="issue-panel-navigation">
          {openPage}
          {next}
        </div>
      ) : null}
    </header>
  );
}
