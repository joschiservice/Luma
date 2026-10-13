import type { CaseSummary } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

import { caseSummaryText } from './case-presentation';

/** Renders the inspector title, retaining the complete text for truncated headings. */
export function IssuePanelHeading({
  item,
  fallback = m.issues_loading_issue(),
}: {
  item?: CaseSummary | undefined;
  fallback?: string;
}) {
  const title =
    (item && caseSummaryText(item.summary))?.replace(/\.+$/, '') ?? fallback;

  return (
    <div className="issue-panel-heading">
      <h2 title={title}>{title}</h2>
    </div>
  );
}
