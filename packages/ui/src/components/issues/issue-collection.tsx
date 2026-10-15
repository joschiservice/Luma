import { m } from '@luma/i18n/messages';
import { ArrowLeft } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { Button } from '../primitives/button';
import { Card } from '../primitives/card';
import { Select } from '../primitives/select';

const CollectionContext = createContext<{
  active: string | null;
  outlet: HTMLDivElement | null;
  headerOutlet: HTMLElement | null;
  inWorkspaceBar: boolean;
  issueTitle?: string | undefined;
  open: (id: string) => void;
  close: () => void;
  dismiss: (id: string) => void;
} | null>(null);

/** Keeps issue details mounted while a collection occupies the same panel. Key by issue ID. */
export function IssueDetailViews({
  children,
  header,
  issueTitle,
  headerClassName = '',
  headerTarget,
}: {
  children: ReactNode;
  header?: ReactNode;
  issueTitle?: string | undefined;
  headerClassName?: string;
  headerTarget?: HTMLElement | null;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [headerOutlet, setHeaderOutlet] = useState<HTMLElement | null>(null);
  const [outlet, setOutlet] = useState<HTMLDivElement | null>(null);
  const dismiss = useCallback(
    (id: string) => setActive((current) => (current === id ? null : current)),
    [],
  );
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef<{
    trigger: HTMLElement | null;
    positions: { element: Element; top: number }[];
  } | null>(null);

  useLayoutEffect(() => {
    if (active) {
      const title = headerOutlet?.querySelector<HTMLElement>('h2');
      (title?.getClientRects().length
        ? title
        : root.current?.querySelector<HTMLElement>(
            '.issue-collection-body-heading h2',
          )
      )?.focus({ preventScroll: true });
      for (const position of previous.current?.positions ?? []) {
        position.element.scrollTop = 0;
      }
    } else if (previous.current) {
      previous.current.trigger?.focus({ preventScroll: true });
      for (const position of previous.current.positions) {
        position.element.scrollTop = position.top;
      }
      previous.current = null;
    }
  }, [active, headerOutlet]);

  function open(id: string) {
    const positions = [];
    let element: Element | null = root.current?.parentElement ?? null;
    while (element) {
      positions.push({ element, top: element.scrollTop });
      element = element.parentElement;
    }
    previous.current = {
      trigger:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      positions,
    };
    setActive(id);
  }

  const Header = headerTarget ? 'div' : 'header';
  const headers = (
    <>
      {active === null ? header : null}
      <Header
        hidden={active === null}
        ref={setHeaderOutlet}
        className={`issue-collection-header ${headerClassName}`}
      />
    </>
  );

  return (
    <CollectionContext.Provider
      value={{
        active,
        outlet,
        headerOutlet,
        inWorkspaceBar: !!headerTarget,
        issueTitle,
        open,
        close: () => setActive(null),
        dismiss,
      }}
    >
      <div
        ref={root}
        onKeyDown={(event) => {
          if (
            active &&
            event.key === 'Escape' &&
            !event.defaultPrevented &&
            !(
              event.target instanceof Element &&
              event.target.closest('input, select, textarea, [role="combobox"]')
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
            setActive(null);
          }
        }}
      >
        {headerTarget ? createPortal(headers, headerTarget) : headers}
        <div hidden={active !== null}>{children}</div>
        <div ref={setOutlet} />
      </div>
    </CollectionContext.Provider>
  );
}

type Filter<T> = {
  label: string;
  value: (item: T) => string;
};

type CollectionProps<T extends { id: string }> = {
  previewCount?: number;
  triggerLabel?: string;
  title: string;
  /** `events` counts history events; any other value counts evidence records. */
  noun: string;
  items: T[];
  renderItems: (items: T[]) => ReactNode;
  filters?: Filter<T>[];
  hasMore?: boolean | undefined;
  loading?: boolean | undefined;
  onLoadMore?: (() => void) | undefined;
  notice?: ReactNode;
};

/** Opens a collection in the enclosing issue view. Previews three records by default; zero shows only the trigger. */
export function IssueCollection<T extends { id: string }>(
  props: CollectionProps<T>,
) {
  const context = useContext(CollectionContext);
  const id = useId();
  const dismiss = context?.dismiss;
  // A live investigation transition may remove the collection that is open.
  useEffect(() => () => dismiss?.(id), [dismiss, id]);
  if (!context) return props.renderItems(props.items);

  return (
    <>
      {props.renderItems(props.items.slice(0, props.previewCount ?? 3))}
      {props.items.length > (props.previewCount ?? 3) || props.hasMore ? (
        <Button
          variant="outline"
          className="issue-collection-open"
          onClick={() => context.open(id)}
        >
          {props.triggerLabel ??
            (props.noun === 'events'
              ? props.hasMore
                ? m.issues_collection_view_events()
                : m.issues_collection_view_all_events({
                    count: props.items.length,
                  })
              : props.hasMore
                ? m.issues_collection_view_evidence()
                : m.issues_collection_view_all_evidence({
                    count: props.items.length,
                  }))}
        </Button>
      ) : null}
      {context.active === id && context.outlet
        ? createPortal(
            <CollectionView {...props} onBack={context.close} />,
            context.outlet,
          )
        : null}
    </>
  );
}

const pageSize = 20;

function CollectionView<T extends { id: string }>({
  title,
  noun,
  items,
  renderItems,
  filters = [],
  hasMore,
  loading,
  onLoadMore,
  notice,
  onBack,
}: CollectionProps<T> & { onBack: () => void }) {
  const context = useContext(CollectionContext);
  const [values, setValues] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const [acceptedIds, setAcceptedIds] = useState(
    () => new Set(items.map((item) => item.id)),
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const newRecords = items.some((item) => !acceptedIds.has(item.id));
  if (loadingOlder && !loading && newRecords) {
    setAcceptedIds(new Set(items.map((item) => item.id)));
    setLoadingOlder(false);
  }
  const accepted = items.filter((item) => acceptedIds.has(item.id));
  const filtered = accepted.filter((item) =>
    filters.every(
      (filter) =>
        !values[filter.label] || filter.value(item) === values[filter.label],
    ),
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / pageSize) - 1),
  );
  const start = currentPage * pageSize;
  const visible = filtered.slice(start, start + pageSize);
  const events = noun === 'events';
  const count = { count: items.length };

  function changePage(next: number) {
    setPage(next);
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
  }

  return (
    <Card
      as="section"
      className="case-investigation case-progress issue-collection-view"
      aria-label={title}
    >
      {context?.headerOutlet
        ? createPortal(
            <>
              <Button variant="ghost" onClick={onBack}>
                <ArrowLeft aria-hidden="true" /> {m.issues_collection_back()}
              </Button>
              <div className="issue-collection-heading">
                <h2 ref={heading} tabIndex={-1}>
                  {title}
                </h2>
                <span>
                  {events
                    ? hasMore
                      ? m.issues_collection_events_loaded(count)
                      : m.issues_collection_events_count(count)
                    : hasMore
                      ? m.issues_collection_evidence_loaded(count)
                      : m.issues_collection_evidence_count(count)}
                </span>
              </div>
              {context.issueTitle ? (
                <p className="issue-collection-context">{context.issueTitle}</p>
              ) : null}
            </>,
            context.headerOutlet,
          )
        : null}
      {context?.inWorkspaceBar ? (
        <div className="issue-collection-body-heading">
          <h2 tabIndex={-1}>{title}</h2>
          <span>
            {events
              ? hasMore
                ? m.issues_collection_events_loaded(count)
                : m.issues_collection_events_count(count)
              : hasMore
                ? m.issues_collection_evidence_loaded(count)
                : m.issues_collection_evidence_count(count)}
          </span>
        </div>
      ) : null}
      <p className="case-caption">{m.issues_newest_first()}</p>
      <div className="issue-collection-filters">
        {filters.map((filter) => (
          <label key={filter.label}>
            {filter.label}
            <Select
              aria-label={filter.label}
              value={values[filter.label] ?? ''}
              onValueChange={(value) => {
                setValues({ ...values, [filter.label]: value ?? '' });
                setPage(0);
              }}
              options={[
                { value: '', label: m.common_all() },
                ...[...new Set(items.map(filter.value))]
                  .filter(Boolean)
                  .sort()
                  .map((value) => ({ value, label: value })),
              ]}
            />
          </label>
        ))}
      </div>
      {notice}
      {newRecords && !loadingOlder ? (
        <Button
          variant="outline"
          onClick={() => {
            setAcceptedIds(new Set(items.map((item) => item.id)));
            changePage(0);
          }}
        >
          {m.issues_collection_new_entries()}
        </Button>
      ) : null}
      {hasMore ? (
        <p className="case-caption">{m.issues_collection_filters_loaded()}</p>
      ) : null}
      {visible.length ? (
        renderItems(visible)
      ) : (
        <p>{m.issues_collection_no_matches()}</p>
      )}
      <nav
        className="issue-collection-pagination"
        aria-label={m.issues_collection_pages({ title })}
      >
        <span role="status">
          {filtered.length
            ? (hasMore
                ? m.issues_collection_range_loaded
                : m.issues_collection_range)({
                start: start + 1,
                end: start + visible.length,
                total: filtered.length,
              })
            : m.issues_collection_no_results()}
        </span>
        <Button
          variant="outline"
          disabled={currentPage === 0}
          onClick={() => changePage(currentPage - 1)}
        >
          {m.common_previous()}
        </Button>
        <Button
          variant="outline"
          disabled={start + pageSize >= filtered.length}
          onClick={() => changePage(currentPage + 1)}
        >
          {m.common_next()}
        </Button>
      </nav>
      {hasMore && onLoadMore ? (
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => {
            setLoadingOlder(true);
            onLoadMore();
          }}
        >
          {loading
            ? m.common_loading()
            : events
              ? m.issues_collection_load_older_events()
              : m.issues_collection_load_older_evidence()}
        </Button>
      ) : null}
    </Card>
  );
}
