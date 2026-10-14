import { m } from '@luma/i18n/messages';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

import { cn } from '../../lib/utils';
import { Badge } from './badge';
import { Button } from './button';
import { LiveRegion } from './live-region';

/** One group of a grouped table or list, in the order the list returned it. */
export interface CollectionGroupSection {
  /** Identifies the group; collapsed groups are remembered by this key. */
  key: string;
  /** The group's name, such as "Open" or "Week of 6 October". */
  label: string;
  /** Every record in the group, not only the rows shown. */
  count: number;
  /** False when the count may be missing records, such as while a source still imports. */
  complete?: boolean | undefined;
  /** Totals shown beside the count, such as amounts per currency. */
  summary?: ReactNode;
  /** The group's rows, such as a table or list. Not rendered while collapsed. */
  content: ReactNode;
  /** Loads more of the group's records; omitted when every record is shown. */
  more?:
    | { onClick: () => void; pending?: boolean | undefined; label?: string }
    | undefined;
}

/**
 * Shows grouped records as sections, each with a header button that collapses it and names the
 * group, its count, an incomplete marker and an optional summary. Collapsing is reported through
 * `onCollapsedChange` (pages keep it as a personal display setting) and announced politely. Rows
 * stay in their table or list, so `useListKeyboard` moves through every expanded group in order.
 * Sections never hide empty groups themselves: the page decides which groups to pass.
 */
export function CollectionGroups({
  label,
  groups,
  collapsed,
  onCollapsedChange,
  empty,
  className,
}: {
  /** Names the grouped list, such as "Orders by status". */
  label: string;
  groups: readonly CollectionGroupSection[];
  collapsed: readonly string[];
  onCollapsedChange: (key: string, collapsed: boolean) => void;
  /** Shown when there are no groups. */
  empty?: ReactNode;
  className?: string | undefined;
}) {
  const id = useId();
  const [announcement, setAnnouncement] = useState('');

  if (!groups.length) return <>{empty}</>;

  return (
    <div
      role="group"
      aria-label={label}
      data-slot="collection-groups"
      className={cn('ui-collection-groups', className)}
    >
      {groups.map((group, index) => {
        const closed = collapsed.includes(group.key);
        const body = `${id}-${index}`;

        return (
          <section
            key={group.key}
            className="ui-collection-group"
            data-collapsed={closed || undefined}
            aria-labelledby={`${body}-label`}
          >
            <h2 className="ui-collection-group-header">
              <button
                type="button"
                className="ui-collection-group-toggle"
                aria-expanded={!closed}
                aria-controls={body}
                onClick={() => {
                  onCollapsedChange(group.key, !closed);
                  setAnnouncement(
                    closed
                      ? m.ui_group_expanded({ group: group.label })
                      : m.ui_group_collapsed({ group: group.label }),
                  );
                }}
              >
                {closed ? (
                  <ChevronRight aria-hidden="true" />
                ) : (
                  <ChevronDown aria-hidden="true" />
                )}
                <span
                  id={`${body}-label`}
                  className="ui-collection-group-label"
                >
                  {group.label}
                </span>
                <span className="ui-collection-group-count">
                  {m.ui_group_count({ count: group.count })}
                </span>
              </button>
              {group.complete === false ? (
                <Badge tone="warning">{m.ui_group_incomplete()}</Badge>
              ) : null}
              {group.summary ? (
                <span className="ui-collection-group-summary">
                  {group.summary}
                </span>
              ) : null}
            </h2>
            <div id={body} hidden={closed} className="ui-collection-group-body">
              {closed ? null : (
                <>
                  {group.content}
                  {group.more ? (
                    <Button
                      variant="ghost"
                      className="ui-collection-group-more"
                      disabled={group.more.pending}
                      onClick={group.more.onClick}
                    >
                      {group.more.label ??
                        m.ui_group_show_more({ group: group.label })}
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          </section>
        );
      })}
      <LiveRegion message={announcement} />
    </div>
  );
}
