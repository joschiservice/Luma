import { type RefObject, useEffect, useState } from 'react';

import { issueSections } from './issue-section';

/** Tracks the visible issue section and moves focus when a reader selects a section. */
export function useIssueNavigation({
  root,
  navigation,
  scrollSelector,
  hasActions,
  issueId,
}: {
  root: RefObject<HTMLDivElement | null>;
  navigation: RefObject<HTMLDivElement | null>;
  scrollSelector: string;
  hasActions: boolean;
  issueId?: string | undefined;
}) {
  const [current, setCurrent] = useState('overview');
  const options = issueSections.filter(
    ({ value }) => value !== 'resolution' || hasActions,
  );

  useEffect(() => {
    const element = root.current;
    const scroll = element?.closest(scrollSelector);
    if (!element || !scroll) return;
    let frame = 0;

    function update() {
      frame = 0;
      if (!element || !scroll) return;
      element.style.setProperty(
        '--issue-navigation-height',
        `${navigation.current?.offsetHeight ?? 0}px`,
      );
      const threshold =
        scroll.getBoundingClientRect().top +
        (navigation.current?.offsetHeight ?? 0) +
        32;
      let selected = 'overview';
      let visible = false;
      for (const section of issueSections) {
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
    }

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
  }, [root, navigation, scrollSelector, issueId, hasActions]);

  function jump(section: string) {
    const target = root.current?.querySelector<HTMLElement>(
      `[data-issue-section="${section}"]`,
    );
    if (!target) return;
    const disclosure = target.querySelector(':scope > details');
    if (disclosure instanceof HTMLDetailsElement) disclosure.open = true;
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

  return { current, options, jump };
}
