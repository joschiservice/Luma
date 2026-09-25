import type { CaseSummary } from '@luma/api-contract';
import type { ReactNode } from 'react';

import { Badge } from '../primitives/badge';
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
          <Badge tone={item.severity === 'high' ? 'warning' : 'neutral'}>
            {item.severity === 'high' ? 'High' : 'Medium'} severity
          </Badge>
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
