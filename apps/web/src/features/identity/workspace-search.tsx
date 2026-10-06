import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@luma/ui/components/primitives/dialog';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Kbd } from '@luma/ui/components/primitives/kbd';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CornerDownLeft,
  type LucideIcon,
  Monitor,
  Moon,
  Plus,
  Search,
  Sparkles,
  Sun,
} from 'lucide-react';
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { askLuma } from '../../lib/assistant-panel';
import { usesCommandKey } from '../../lib/keyboard';
import { setThemePreference, type ThemePreference } from '../../lib/theme';
import { ordersOptions, suppliersOptions } from '../procurement/data';
import { recordsOptions } from '../records/data';
import { workspaceDestinations } from './workspace-destinations';

const subscribePlatform = () => () => undefined;
const platformModifier = () => (usesCommandKey() ? '⌘' : 'Ctrl');

type Command = {
  id: string;
  label: string;
  description: string;
  Icon: LucideIcon;
  keywords: string;
} & (
  | { kind: 'theme'; theme: ThemePreference }
  | { kind: 'assistant' }
  | { kind: 'link'; render: (children: ReactNode) => ReactNode }
);

const commands: Command[] = [
  {
    id: 'assistant',
    kind: 'assistant',
    label: 'Ask Luma',
    description: 'Ask about orders, issues, stock, fulfillment and returns',
    Icon: Sparkles,
    keywords: 'ask luma assistant ai chat question answer',
  },
  {
    id: 'theme-light',
    kind: 'theme',
    theme: 'light',
    label: 'Use light appearance',
    description: 'Switch the workspace to the light theme',
    Icon: Sun,
    keywords: 'theme appearance light mode',
  },
  {
    id: 'theme-dark',
    kind: 'theme',
    theme: 'dark',
    label: 'Use dark appearance',
    description: 'Switch the workspace to the dark theme',
    Icon: Moon,
    keywords: 'theme appearance dark mode night',
  },
  {
    id: 'theme-system',
    kind: 'theme',
    theme: 'system',
    label: 'Match system appearance',
    description: 'Follow your operating system setting',
    Icon: Monitor,
    keywords: 'theme appearance system auto',
  },
  {
    id: 'workspace-new',
    kind: 'link',
    label: 'Create workspace',
    description: 'Start a new workspace for another business',
    Icon: Plus,
    keywords: 'new workspace organization create',
    render: (children) => <Link to="/app/workspaces/new">{children}</Link>,
  },
  {
    id: 'docs',
    kind: 'link',
    label: 'Open documentation',
    description: 'Guides for working in Luma, opened in a new tab',
    Icon: BookOpen,
    keywords: 'help docs documentation guide',
    render: (children) => (
      <a href="/docs" target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
  },
];

function matches(query: string, text: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = text.toLowerCase();

  return terms.every((term) => haystack.includes(term));
}

/**
 * Opens the command menu for pages and workspace actions with ⌘K or Ctrl K. Arrow keys
 * move between results, Enter opens the first match, and focus returns on dismissal.
 */
export function WorkspaceSearch({
  organizationId,
}: {
  organizationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [recordQuery, setRecordQuery] = useState('');
  const modifier = useSyncExternalStore(
    subscribePlatform,
    platformModifier,
    () => 'Ctrl',
  );
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLElement>(null);
  // Asking Luma hands focus to its composer instead of the menu trigger.
  const handoff = useRef(false);

  function changeOpen(value: boolean) {
    setOpen(value);
    if (!value) setQuery('');
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setQuery('');
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setRecordQuery(query.trim()), 250);

    return () => clearTimeout(timer);
  }, [query]);

  const records = useQuery({
    ...recordsOptions(organizationId, { q: recordQuery }),
    enabled: open && recordQuery.length >= 2,
  });

  // Procurement records are Luma-owned, so they are searched here rather than in Records.
  const purchasing = open && recordQuery.length >= 2;
  const procurementOrders = useQuery({
    ...ordersOptions(organizationId),
    enabled: purchasing,
  });
  const procurementSuppliers = useQuery({
    ...suppliersOptions(organizationId),
    enabled: purchasing,
  });
  const purchaseResults = purchasing
    ? [
        ...(procurementSuppliers.data?.items ?? [])
          .filter((s) => matches(recordQuery, s.name))
          .slice(0, 3)
          .map((s) => ({
            key: `supplier:${s.id}`,
            label: s.name,
            detail: 'Supplier',
            supplierId: s.id,
          })),
        ...(procurementOrders.data?.items ?? [])
          .filter((o) =>
            matches(
              recordQuery,
              [o.reference, o.supplierName, ...o.lines.map((l) => l.sku)].join(
                ' ',
              ),
            ),
          )
          .slice(0, 5)
          .map((o) => ({
            key: `purchase_order:${o.id}`,
            label: o.reference,
            detail: `Purchase order · ${o.supplierName}`,
            purchaseOrderId: o.id,
          })),
      ]
    : [];
  const pages = workspaceDestinations.filter((item) =>
    matches(query, `${item.label} ${item.description}`),
  );
  // Any longer query can become a question for Luma.
  const question = query.trim().length >= 3 ? query.trim() : '';
  const actions = query.trim()
    ? commands.filter(
        (item) =>
          (item.kind === 'assistant' && question) ||
          matches(query, `${item.label} ${item.description} ${item.keywords}`),
      )
    : commands;
  const focusable = () =>
    Array.from(
      results.current?.querySelectorAll<HTMLElement>('a, button') ?? [],
    );

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger className="sidebar-search" aria-label="Search pages">
        <Search size={15} aria-hidden="true" />
        <span className="sidebar-search-label">Search</span>
        <span className="sidebar-search-keys" aria-hidden="true">
          <Kbd>{modifier}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </DialogTrigger>
      <DialogContent
        className="command-palette"
        showCloseButton={false}
        initialFocus={input}
        finalFocus={() => {
          if (!handoff.current) return true;
          handoff.current = false;

          return document.getElementById('assistant-question') ?? true;
        }}
      >
        <DialogTitle className="sr-only">
          Go to a page or run a command
        </DialogTitle>
        <DialogDescription className="sr-only">
          Find a page or action in your workspace. Use the arrow keys to browse
          results and Enter to open the first match.
        </DialogDescription>
        <div className="command-input-row">
          <Search size={17} aria-hidden="true" />
          <input
            ref={input}
            aria-label="Search workspace"
            placeholder="Search records, pages and actions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              const items = focusable();
              if (!items.length) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                items[
                  event.key === 'ArrowDown' ? 0 : items.length - 1
                ]?.focus();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                items[0]?.click();
              }
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <nav
          ref={results}
          aria-label="Search results"
          className="command-results"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const items = focusable();
            const index = items.indexOf(event.target as HTMLElement);
            const next = index + (event.key === 'ArrowDown' ? 1 : -1);
            if (next < 0 || next >= items.length) input.current?.focus();
            else items[next]?.focus();
          }}
        >
          {pages.length ? <p className="command-section-label">Go to</p> : null}
          {pages.map(({ path, label, Icon, description, domain, shortcut }) => (
            <Link
              key={path}
              className="command-item"
              to={`/app/$organizationId/${path}`}
              params={{ organizationId }}
              onClick={() => changeOpen(false)}
            >
              <span className="command-item-icon">
                {domain ? (
                  <DomainIcon domain={domain} size="sm" />
                ) : (
                  <Icon size={16} aria-hidden="true" />
                )}
              </span>
              <span className="command-item-copy">
                <strong>{label}</strong>
                <span>{description}</span>
              </span>
              <span className="command-item-keys" aria-hidden="true">
                <Kbd>G</Kbd>
                <Kbd>{shortcut.toUpperCase()}</Kbd>
              </span>
            </Link>
          ))}
          {recordQuery.length >= 2 ? (
            <p className="command-section-label">Records</p>
          ) : null}
          {records.data?.items.slice(0, 8).map((record) => (
            <Link
              key={`${record.kind}:${record.id}`}
              className="command-item"
              {...(record.kind === 'order'
                ? {
                    to: '/app/$organizationId/orders/$orderId' as const,
                    params: { organizationId, orderId: record.id },
                    search: { q: recordQuery },
                  }
                : record.kind === 'sku'
                  ? {
                      to: '/app/$organizationId/products/$skuId' as const,
                      params: { organizationId, skuId: record.id },
                      search: { q: recordQuery },
                    }
                  : record.kind === 'fulfillment'
                    ? {
                        to: '/app/$organizationId/fulfillment/$fulfillmentId' as const,
                        params: { organizationId, fulfillmentId: record.id },
                        search: { q: recordQuery, view: 'all' as const },
                      }
                    : {
                        to: '/app/$organizationId/records/$kind/$recordId' as const,
                        params: {
                          organizationId,
                          kind: record.kind,
                          recordId: record.id,
                        },
                        search: { q: recordQuery },
                      })}
              onClick={() => changeOpen(false)}
            >
              <span className="command-item-icon">
                <Search size={16} aria-hidden="true" />
              </span>
              <span className="command-item-copy">
                <strong>{record.label}</strong>
                <span>
                  {record.kind} · {record.description}
                </span>
              </span>
              <CornerDownLeft
                className="command-item-enter"
                size={14}
                aria-hidden="true"
              />
            </Link>
          ))}
          {purchaseResults.map((item) => (
            <Link
              key={item.key}
              className="command-item"
              {...('supplierId' in item
                ? {
                    to: '/app/$organizationId/procurement/suppliers/$supplierId' as const,
                    params: { organizationId, supplierId: item.supplierId },
                  }
                : {
                    to: '/app/$organizationId/procurement/$purchaseOrderId' as const,
                    params: {
                      organizationId,
                      purchaseOrderId: item.purchaseOrderId,
                    },
                  })}
              onClick={() => changeOpen(false)}
            >
              <span className="command-item-icon">
                <DomainIcon domain="procurement" size="sm" />
              </span>
              <span className="command-item-copy">
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </span>
              <CornerDownLeft
                className="command-item-enter"
                size={14}
                aria-hidden="true"
              />
            </Link>
          ))}
          {recordQuery.length >= 2 && records.isPending ? (
            <p className="command-section-label" role="status">
              Searching records…
            </p>
          ) : null}
          {actions.length ? (
            <p className="command-section-label">Actions</p>
          ) : null}
          {actions.map((command) => {
            const content = (
              <>
                <span className="command-item-icon">
                  <command.Icon size={16} aria-hidden="true" />
                </span>
                <span className="command-item-copy">
                  <strong>{command.label}</strong>
                  <span>
                    {command.kind === 'assistant' && question
                      ? `Ask “${question}”`
                      : command.description}
                  </span>
                </span>
                <CornerDownLeft
                  className="command-item-enter"
                  size={14}
                  aria-hidden="true"
                />
              </>
            );

            return command.kind === 'theme' || command.kind === 'assistant' ? (
              <button
                key={command.id}
                type="button"
                className="command-item"
                onClick={() => {
                  if (command.kind === 'theme')
                    setThemePreference(command.theme);
                  else {
                    handoff.current = true;
                    askLuma(question);
                  }
                  changeOpen(false);
                }}
              >
                {content}
              </button>
            ) : (
              <span
                key={command.id}
                className="command-item-link"
                onClickCapture={() => changeOpen(false)}
              >
                {command.render(content)}
              </span>
            );
          })}
          {!pages.length &&
          !actions.length &&
          !records.data?.items.length &&
          !purchaseResults.length ? (
            <div className="command-empty" role="status">
              <Search size={20} aria-hidden="true" />
              <strong>No pages found</strong>
              <span>Try Issues, Workflows or Apps.</span>
            </div>
          ) : null}
        </nav>
        <footer className="command-footer">
          <span>
            <ArrowUp size={12} aria-hidden="true" />
            <ArrowDown size={12} aria-hidden="true" /> Move
          </span>
          <span>
            <CornerDownLeft size={12} aria-hidden="true" /> Open
          </span>
          <span className="command-footer-hint">
            Press <Kbd>G</Kbd> then a letter to jump anywhere
          </span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
