import { m } from '@luma/i18n/messages';
import { CircleDot, History, Inbox } from 'lucide-react';

import type { CollectionView } from '../primitives/collection-toolbar';

const views = [
  { value: 'active', label: m.issues_view_open, icon: CircleDot },
  { value: 'needs_you', label: m.issues_view_needs_review, icon: Inbox },
  { value: 'history', label: m.issues_view_history, icon: History },
] as const;

type IssueView = (typeof views)[number]['value'];

/** The built-in issue views with icons whose colors accent open and review work. */
export function issueViews(): CollectionView<IssueView>[] {
  return views.map(({ value, label, icon: Icon }) => ({
    value,
    label: label(),
    icon: (
      <Icon aria-hidden="true" className="issue-view-icon" data-view={value} />
    ),
  }));
}
