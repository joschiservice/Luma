import type { CaseSummary } from '@luma/api-contract';

import { IssueContext } from './issue-context';

/** Renders the inspector title, severity, and compact issue metadata. */
export function IssuePanelHeading({
  item,
  fallback = 'Loading issue…',
}: {
  item?: CaseSummary | undefined;
  fallback?: string;
}) {
  const title = item?.summary.replace(/\.+$/, '') ?? fallback;

  return (
    <>
      <div className="issue-panel-heading">
        <h2 title={title}>{title}</h2>
      </div>
      {item && (
        <span
          className={`issue-panel-severity issue-panel-severity-${item.severity}`}
        >
          {item.severity === 'high' ? 'High' : 'Medium'} severity
        </span>
      )}
      {item && (
        <div className="issue-panel-context">
          <IssueContext item={item} />
        </div>
      )}
    </>
  );
}
