import { m } from '@luma/i18n/messages';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../primitives/resizable';

/** Keeps inbox and issue content mounted while switching between resizable and single-pane layouts. */
export function IssueSplitView({
  selected,
  list,
  detail,
}: {
  selected: boolean;
  list: ReactNode;
  detail: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => {
      setNarrow(element.clientWidth <= 720 || media.matches);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    media.addEventListener('change', update);
    update();

    return () => {
      observer.disconnect();
      media.removeEventListener('change', update);
    };
  }, []);

  const singlePane = narrow || !selected;

  return (
    <div
      className="inbox-workspace issue-split-view"
      ref={root}
      data-single-pane={singlePane || undefined}
      data-selected={selected || undefined}
    >
      <ResizablePanelGroup orientation="horizontal" disabled={singlePane}>
        <ResizablePanel
          id="issue-list"
          defaultSize="42.5%"
          minSize="340px"
          className="issue-split-pane"
        >
          {list}
        </ResizablePanel>
        <ResizableHandle
          withHandle
          aria-label={m.issues_panel_resize()}
          disabled={singlePane}
        />
        <ResizablePanel
          id="issue-detail"
          defaultSize="57.5%"
          minSize="360px"
          className="issue-split-pane"
        >
          {detail}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
