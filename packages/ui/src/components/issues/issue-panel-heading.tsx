import type { CaseSummary } from '@luma/api-contract';

/** Renders the inspector title, retaining the complete text for truncated headings. */
export function IssuePanelHeading({
  item,
  fallback = 'Loading issue…',
}: {
  item?: CaseSummary | undefined;
  fallback?: string;
}) {
  const title = item?.summary.replace(/\.+$/, '') ?? fallback;

  return (
    <div className="issue-panel-heading">
      <h2 title={title}>{title}</h2>
    </div>
  );
}
