import type { CaseDetail } from '@luma/api-contract';
import { type ReactNode, useContext, useEffect, useRef } from 'react';

import { Button } from '../primitives/button';
import { SectionNavigation } from '../primitives/section-navigation';
import { WorkspaceHeaderSlot } from '../workspace/workspace-header-slot';
import { caseLabel, CaseStatus } from './case-investigation';
import { IssueDetailViews } from './issue-collection';
import { IssueRecordDetails } from './issue-record-details';
import { IssuePageNavigation, IssueSection } from './issue-section';
import { IssueSectionSelect } from './issue-section-select';
import { useIssueNavigation } from './use-issue-navigation';

/** Provides a compact workspace header, persistent section navigation, and one issue column. */
export function IssuePageLayout({
  item,
  back,
  refresh,
  children,
  actions,
  canReview = false,
}: {
  item?: CaseDetail | undefined;
  back: ReactNode;
  refresh?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  canReview?: boolean;
}) {
  const headerTarget = useContext(WorkspaceHeaderSlot);
  const root = useRef<HTMLDivElement>(null);
  const mobileNavigation = useRef<HTMLDivElement>(null);
  const { current, options, jump } = useIssueNavigation({
    root,
    navigation: mobileNavigation,
    scrollSelector: '.desk-content',
    hasActions: Boolean(actions),
    issueId: item?.id,
  });
  const title = item?.summary.replace(/\.+$/, '') ?? 'Issue details';

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [item?.id]);

  return (
    <div className="issue-page issue-content" ref={root} tabIndex={-1}>
      <IssuePageNavigation.Provider value={jump}>
        <IssueDetailViews
          key={item?.id ?? 'pending'}
          issueTitle={item?.summary}
          headerClassName="issue-page-collection-header"
          headerTarget={headerTarget}
          header={
            <div className="issue-page-header">
              <div className="issue-page-back">{back}</div>
              <div className="issue-page-identity">
                <div className="issue-page-title">
                  <h1 tabIndex={0}>{title}</h1>
                  <span className="issue-page-full-title" aria-hidden="true">
                    {title}
                  </span>
                </div>
                {item ? <CaseStatus item={item} /> : null}
              </div>
              <div className="issue-page-actions">
                {refresh}
                {canReview ? (
                  <Button
                    aria-label="Review resolution"
                    onClick={() => jump('resolution')}
                  >
                    <span className="issue-page-desktop-label">
                      Review resolution
                    </span>
                    <span className="issue-page-mobile-label">Review</span>
                  </Button>
                ) : null}
              </div>
            </div>
          }
        >
          <div className="issue-page-workspace">
            {item ? (
              <>
                <SectionNavigation
                  className="issue-page-sections"
                  aria-label="Issue sections"
                  items={options}
                  value={current}
                  onValueChange={jump}
                />
                <div className="issue-page-mobile-nav" ref={mobileNavigation}>
                  <span>On this page</span>
                  <IssueSectionSelect
                    label="On this page"
                    value={current}
                    options={options}
                    onNavigate={jump}
                  />
                </div>
              </>
            ) : null}
            <div className="issue-page-main issue-content-main">
              {children}
              {actions ? (
                <IssueSection section="resolution">{actions}</IssueSection>
              ) : null}
              {item ? (
                <IssueSection section="details">
                  <dl className="issue-page-facts">
                    <div>
                      <dt>Source systems</dt>
                      <dd>
                        {item.sources.length
                          ? item.sources.join(' · ')
                          : 'Source system unknown'}
                      </dd>
                    </div>
                    <div>
                      <dt>Issue type</dt>
                      <dd>{caseLabel(item.class)}</dd>
                    </div>
                    <div>
                      <dt>Evidence freshness</dt>
                      <dd>{caseLabel(item.freshness)}</dd>
                    </div>
                  </dl>
                  <IssueRecordDetails item={item} expanded />
                </IssueSection>
              ) : null}
            </div>
          </div>
        </IssueDetailViews>
      </IssuePageNavigation.Provider>
    </div>
  );
}
