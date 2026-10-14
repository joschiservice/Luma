import { m } from '@luma/i18n/messages';
import { ArrowLeft, X } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { isTypingTarget } from '../../lib/list-keyboard';
import { cn } from '../../lib/utils';
import { Button } from './button';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './resizable';

/** Focuses the row the list keys act on, else the open row, else the list itself. */
function focusListRow(list: HTMLElement | null) {
  const row =
    list?.querySelector('[data-list-row][data-focused]') ??
    list?.querySelector('[data-list-row][data-current]') ??
    list?.querySelector('[data-list-row]:has([aria-current="page"])');
  const target =
    row?.querySelector<HTMLElement>(
      '[data-row-focus], [data-slot="data-table-row-link"]',
    ) ?? (row instanceof HTMLElement ? row : list);
  target?.focus({ preventScroll: true });
}

/**
 * Shows the open record of a table or list next to it. On wide screens the preview takes a
 * resizable pane beside the list; on narrow ones it opens as a full-screen sheet over the list,
 * which is inert meanwhile. Both panes stay mounted across layout changes, so scroll positions
 * and local state survive resizing. Escape inside the preview closes it, and closing returns
 * focus to the focused row. The page owns which record is open, usually in the URL, and passes
 * its content; wire `useListKeyboard`'s `preview` for Space, J/K and Escape in the list.
 */
export function CollectionPreview({
  open,
  list,
  preview,
  label,
  title,
  actions,
  onClose,
  className,
}: {
  /** A record is open. */
  open: boolean;
  /** The table or list, including its notices and pagination. */
  list: ReactNode;
  /** The open record's preview; pages render a summary and link to the full record. */
  preview: ReactNode;
  /** Names the preview region, such as "Order preview". */
  label: string;
  /** The open record's name, shown in the preview's header. */
  title?: ReactNode;
  /** Header controls, such as a link that opens the full record. */
  actions?: ReactNode;
  onClose: () => void;
  className?: string | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  const listPane = useRef<HTMLDivElement>(null);
  const previewPane = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setNarrow(element.clientWidth <= 720 || media.matches);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    media.addEventListener('change', update);
    update();

    return () => {
      observer.disconnect();
      media.removeEventListener('change', update);
    };
  }, []);

  const sheet = narrow && open;
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    const opened = open && !wasOpen.current;
    const closed = !open && wasOpen.current;
    wasOpen.current = open;
    // A sheet covers the list, so focus moves into it; a pane beside the list leaves focus there.
    if (opened && sheet) previewPane.current?.focus({ preventScroll: true });
    const active = document.activeElement;
    if (
      closed &&
      (!active ||
        active === document.body ||
        previewPane.current?.contains(active))
    )
      focusListRow(listPane.current);
  }, [open, sheet]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      isTypingTarget(event.target) ||
      (event.target instanceof Element &&
        event.target.closest(
          '[role="dialog"], [role="menu"], [role="listbox"]',
        ))
    )
      return;
    event.preventDefault();
    onClose();
  };

  return (
    <div
      ref={root}
      data-slot="collection-preview"
      data-open={open || undefined}
      data-sheet={sheet || undefined}
      className={cn('ui-collection-preview', className)}
    >
      <ResizablePanelGroup orientation="horizontal" disabled={!open || narrow}>
        <ResizablePanel
          id="collection-list"
          defaultSize="55%"
          minSize="320px"
          className="ui-collection-preview-panel"
        >
          <div
            ref={listPane}
            className="ui-collection-preview-list"
            inert={sheet || undefined}
          >
            {list}
          </div>
        </ResizablePanel>
        <ResizableHandle
          withHandle
          aria-label={m.ui_preview_resize()}
          disabled={!open || narrow}
        />
        <ResizablePanel
          id="collection-preview"
          defaultSize="45%"
          minSize="320px"
          className="ui-collection-preview-panel"
        >
          <section
            ref={previewPane}
            className="ui-collection-preview-pane"
            aria-label={label}
            tabIndex={-1}
            hidden={!open}
            onKeyDown={onKeyDown}
          >
            <header className="ui-collection-preview-header">
              <Button
                variant="ghost"
                size={sheet ? 'default' : 'icon'}
                aria-label={sheet ? undefined : m.ui_preview_close()}
                title={sheet ? undefined : m.ui_preview_close()}
                onClick={onClose}
              >
                {sheet ? (
                  <>
                    <ArrowLeft aria-hidden="true" />
                    {m.ui_preview_back()}
                  </>
                ) : (
                  <X aria-hidden="true" />
                )}
              </Button>
              {title ? (
                <h2 className="ui-collection-preview-title">{title}</h2>
              ) : null}
              {actions ? (
                <div className="ui-collection-preview-actions">{actions}</div>
              ) : null}
            </header>
            <div className="ui-collection-preview-body">{preview}</div>
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
