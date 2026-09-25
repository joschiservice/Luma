import type { CaseDetail } from '@luma/api-contract';
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react';

import { Button } from './button';
import { caseLabel, CaseStatus } from './case-investigation';
import { IssueDetailViews } from './issue-collection';
import { IssueRecordDetails } from './issue-record-details';
import {
  IssuePageNavigation,
  IssueSection,
  issueSections as sections,
} from './issue-section';
import { SectionNavigation } from './section-navigation';
import { Select } from './select';
import { WorkspaceHeaderSlot } from './workspace-header-slot';

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
  const [current, setCurrent] = useState('overview');
  const hasActions = Boolean(actions);
  const options = sections.filter(
    ({ value }) => value !== 'resolution' || hasActions,
  );
  const title = item?.summary.replace(/\.+$/, '') ?? 'Issue details';

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [item?.id]);

  useEffect(() => {
    const element = root.current;
    const scroll = element?.closest('.desk-content');
    if (!element || !scroll) return;
    let frame = 0;

    const update = () => {
      frame = 0;
      const threshold =
        scroll.getBoundingClientRect().top +
        (mobileNavigation.current?.offsetHeight ?? 0) +
        32;
      let selected = 'overview';
      let visible = false;
      for (const section of sections) {
        if (section.value === 'resolution' && !hasActions) continue;
        const target = element.querySelector<HTMLElement>(
          `[data-issue-section="${section.value}"]`,
        );
        if (!target?.offsetParent) continue;
        visible = true;
        if (target.getBoundingClientRect().top <= threshold)
          selected = section.value;
      }
      if (!visible) return;
      if (
        scroll.scrollTop > 0 &&
        scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2
      )
        selected = 'details';
      setCurrent(selected);
    };

    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }

    scroll.addEventListener('scroll', schedule, { passive: true });
    element.addEventListener('toggle', schedule, true);
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(scroll);
    schedule();

    return () => {
      scroll.removeEventListener('scroll', schedule);
      element.removeEventListener('toggle', schedule, true);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [item?.id, hasActions]);

  function jump(section: string) {
    const target = root.current?.querySelector<HTMLElement>(
      `[data-issue-section="${section}"]`,
    );
    if (!target) return;
    let parent: HTMLElement | null = target;
    while (parent && parent !== root.current) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
      parent = parent.parentElement;
    }
    const focus =
      target instanceof HTMLDetailsElement
        ? target.querySelector('summary')
        : target;
    focus?.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
    setCurrent(section);
  }

  return (
    <div className="issue-page" ref={root} tabIndex={-1}>
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
                  <Select
                    aria-label="On this page"
                    value={current}
                    options={options}
                    onValueChange={(value) => {
                      if (value) jump(value);
                    }}
                  />
                </div>
              </>
            ) : null}
            <div className="issue-page-main">
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
