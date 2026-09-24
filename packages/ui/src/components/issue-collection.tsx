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

import { Button } from './button';
import { Select } from './select';

const CollectionContext = createContext<{
  active: string | null;
  outlet: HTMLDivElement | null;
  headerOutlet: HTMLElement | null;
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
      headerOutlet
        ?.querySelector<HTMLElement>('h2')
        ?.focus({ preventScroll: true });
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
  title: string;
  noun: string;
  items: T[];
  renderItems: (items: T[]) => ReactNode;
  filters?: Filter<T>[];
  hasMore?: boolean | undefined;
  loading?: boolean | undefined;
  onLoadMore?: (() => void) | undefined;
  notice?: ReactNode;
};

/** Shows three records and opens the full collection in the enclosing issue panel. */
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
      {props.renderItems(props.items.slice(0, 3))}
      {props.items.length > 3 || props.hasMore ? (
        <Button
          variant="outline"
          className="issue-collection-open"
          onClick={() => context.open(id)}
        >
          {props.hasMore
            ? `View ${props.noun}`
            : `View all ${props.items.length} ${props.noun}`}
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

  function changePage(next: number) {
    setPage(next);
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
  }

  return (
    <section
      className="case-investigation case-progress issue-collection-view"
      aria-label={title}
    >
      {context?.headerOutlet
        ? createPortal(
            <>
              <Button variant="ghost" onClick={onBack}>
                <ArrowLeft aria-hidden="true" /> Back to issue
              </Button>
              <div className="issue-collection-heading">
                <h2 ref={heading} tabIndex={-1}>
                  {title}
                </h2>
                <span>
                  {items.length} {noun === 'events' ? 'events' : 'records'}
                  {hasMore ? ' loaded' : ''}
                </span>
              </div>
              {context.issueTitle ? (
                <p className="issue-collection-context">{context.issueTitle}</p>
              ) : null}
            </>,
            context.headerOutlet,
          )
        : null}
      <p className="case-caption">Newest first</p>
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
                { value: '', label: 'All' },
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
          New records available · Update list
        </Button>
      ) : null}
      {hasMore ? (
        <p className="case-caption">
          Filters apply to loaded records. Load older records to search further
          back.
        </p>
      ) : null}
      {visible.length ? renderItems(visible) : <p>No matching {noun}.</p>}
      <nav
        className="issue-collection-pagination"
        aria-label={`${title} pages`}
      >
        <span role="status">
          {filtered.length
            ? `${start + 1}–${start + visible.length} of ${filtered.length}${hasMore ? ' loaded' : ''}`
            : '0 results'}
        </span>
        <Button
          variant="outline"
          disabled={currentPage === 0}
          onClick={() => changePage(currentPage - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          disabled={start + pageSize >= filtered.length}
          onClick={() => changePage(currentPage + 1)}
        >
          Next
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
          {loading ? 'Loading…' : `Load older ${noun}`}
        </Button>
      ) : null}
    </section>
  );
}
