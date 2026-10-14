import { m } from '@luma/i18n/messages';
import { CircleDot, History, Inbox } from 'lucide-react';
import type { ReactElement } from 'react';

import { Tabs, TabsList, TabsTrigger } from '../primitives/tabs';

const views = [
  { value: 'needs_you', label: m.issues_view_needs_review, icon: Inbox },
  { value: 'active', label: m.issues_view_open, icon: CircleDot },
  { value: 'history', label: m.issues_view_history, icon: History },
] as const;

type IssueView = (typeof views)[number]['value'];

/**
 * Displays URL-backed issue views with manual keyboard activation and semantic status accents.
 * A null value marks no tab as current, as while a saved view is open.
 */
export function IssueViewTabs({
  value,
  renderLink,
}: {
  value: IssueView | null;
  renderLink: (view: IssueView) => ReactElement;
}) {
  return (
    <Tabs value={value} className="issue-view-tabs">
      <TabsList aria-label={m.issues_views_label()} activateOnFocus={false}>
        {views.map(({ value: view, label, icon: Icon }) => (
          <TabsTrigger
            key={view}
            value={view}
            data-view={view}
            nativeButton={false}
            render={renderLink(view)}
          >
            <Icon aria-hidden="true" />
            {label()}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
