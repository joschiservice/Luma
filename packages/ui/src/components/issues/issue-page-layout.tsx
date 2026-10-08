import type { CaseDetail } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { type ReactNode, useContext, useEffect, useRef } from 'react';

import { Button } from '../primitives/button';
import { SectionNavigation } from '../primitives/section-navigation';
import { WorkspaceHeaderSlot } from '../workspace/workspace-header-slot';
import { CaseStatus } from './case-investigation';
import { freshnessLabel, issueKind, sourceLabel } from './case-presentation';
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
  const title = item?.summary.replace(/\.+$/, '') ?? m.issues_section_details();

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
                    aria-label={m.issues_page_review_change()}
                    onClick={() => jump('resolution')}
                  >
                    <span className="issue-page-desktop-label">
                      {m.issues_page_review_change()}
                    </span>
                    <span className="issue-page-mobile-label">
                      {m.issues_review_short()}
                    </span>
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
                  aria-label={m.issues_sections_label()}
                  items={options}
                  value={current}
                  onValueChange={jump}
                />
                <div className="issue-page-mobile-nav" ref={mobileNavigation}>
                  <span>{m.issues_on_this_page()}</span>
                  <IssueSectionSelect
                    label={m.issues_on_this_page()}
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
                      <dt>{m.issues_details_sources()}</dt>
                      <dd>
                        {item.sources.length
                          ? item.sources.map(sourceLabel).join(' · ')
                          : m.issues_source_system_unknown()}
                      </dd>
                    </div>
                    <div>
                      <dt>{m.issues_filter_type()}</dt>
                      <dd>{issueKind(item).label}</dd>
                    </div>
                    <div>
                      <dt>{m.issues_details_freshness()}</dt>
                      <dd>{freshnessLabel(item.freshness)}</dd>
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
