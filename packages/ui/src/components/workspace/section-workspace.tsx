import { m } from '@luma/i18n/messages';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { SectionNavigation } from '../primitives/section-navigation';
import { SectionSelect } from '../primitives/section-select';

type WorkspaceSection = { value: string; label: string; content: ReactNode };

/** Renders labeled sections with sticky navigation, scroll tracking, and focus on explicit navigation. Values must be unique. */
export function SectionWorkspace({
  sections,
  label,
}: {
  sections: WorkspaceSection[];
  label: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const mobile = useRef<HTMLDivElement>(null);
  const targets = useRef(new Map<string, HTMLElement>());
  const selectedPosition = useRef<{ value: string; scrollTop: number } | null>(
    null,
  );
  const [current, setCurrent] = useState(sections[0]?.value ?? '');
  const sectionKey = JSON.stringify(sections.map((section) => section.value));

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const values: string[] = JSON.parse(sectionKey);
    const scroll = element.closest('.desk-content');
    const source = scroll ?? window;
    let frame = 0;

    function update() {
      frame = 0;
      const offset = mobile.current?.offsetHeight ?? 0;
      element?.style.setProperty('--section-navigation-height', `${offset}px`);
      const threshold =
        (scroll?.getBoundingClientRect().top ?? 0) + offset + 32;
      const scrollTop = scroll?.scrollTop ?? window.scrollY;
      // Near the page end, a chosen section cannot always align with the top.
      // Keep that choice highlighted until the reader scrolls again.
      if (selectedPosition.current?.scrollTop === scrollTop) {
        setCurrent(selectedPosition.current.value);

        return;
      }
      selectedPosition.current = null;
      let selected = values[0] ?? '';
      for (const key of values) {
        const target = targets.current.get(key);
        if (target && target.getBoundingClientRect().top <= threshold)
          selected = key;
      }
      if (
        scroll &&
        scroll.scrollTop > 0 &&
        scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2
      )
        selected = values.at(-1) ?? selected;
      setCurrent(selected);
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }

    source.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    schedule();

    return () => {
      source.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [sectionKey]);

  function jump(value: string) {
    const target = targets.current.get(value);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
    selectedPosition.current = {
      value,
      scrollTop:
        root.current?.closest('.desk-content')?.scrollTop ?? window.scrollY,
    };
    setCurrent(value);
  }

  return (
    <div className="section-workspace" ref={root}>
      <SectionNavigation
        className="section-workspace-navigation"
        aria-label={label}
        items={sections}
        value={current}
        onValueChange={jump}
      />
      <div className="section-workspace-mobile" ref={mobile}>
        <span>{m.ui_section_navigation_title()}</span>
        <SectionSelect
          label={label}
          value={current}
          options={sections.map(({ value, label }) => ({ value, label }))}
          onNavigate={jump}
        />
      </div>
      <div className="section-workspace-main">
        {sections.map((section) => (
          <section
            key={section.value}
            ref={(element) => {
              if (element) targets.current.set(section.value, element);
              else targets.current.delete(section.value);
            }}
            tabIndex={-1}
            aria-label={section.label}
            id={`${id}-${section.value}`}
            className="section-workspace-section"
          >
            {section.content}
          </section>
        ))}
      </div>
    </div>
  );
}
