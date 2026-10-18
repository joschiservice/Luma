import type { CaseDetail } from '@luma/api-contract';
import { type ReactNode, useLayoutEffect, useRef } from 'react';

import { IssueDetailViews } from './issue-collection';
import { IssueRecordDetails } from './issue-record-details';
import {
  IssuePageNavigation,
  IssuePanelSections,
  IssueSection,
} from './issue-section';
import { useIssueNavigation } from './use-issue-navigation';

/** Shares the issue page's sections in an inspector with collapsible supporting sections and collection views. */
export function IssuePanelLayout({
  item,
  header,
  children,
  actions,
}: {
  item?: CaseDetail | undefined;
  header: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLDivElement>(null);
  const { jump } = useIssueNavigation({
    root,
    navigation,
    scrollSelector: '.inbox-detail',
    hasActions: Boolean(actions),
    issueId: item?.id,
  });

  useLayoutEffect(() => {
    const scroll = root.current?.closest('.inbox-detail');
    if (scroll) scroll.scrollTop = 0;
  }, [item?.id]);

  return (
    <div className="issue-panel issue-content" ref={root}>
      <IssuePageNavigation.Provider value={jump}>
        <IssuePanelSections.Provider value={true}>
          <IssueDetailViews
            issueTitle={item?.summary}
            headerClassName="inbox-case-nav"
            header={
              <div className="issue-panel-header" ref={navigation}>
                {header}
              </div>
            }
          >
            <div className="issue-content-main issue-panel-content">
              {children}
              {actions ? (
                <IssueSection section="resolution">{actions}</IssueSection>
              ) : null}
              {item ? (
                <IssueSection section="details">
                  <IssueRecordDetails item={item} embedded />
                </IssueSection>
              ) : null}
            </div>
          </IssueDetailViews>
        </IssuePanelSections.Provider>
      </IssuePageNavigation.Provider>
    </div>
  );
}
