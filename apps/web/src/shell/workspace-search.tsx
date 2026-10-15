import type { RecordKind } from '@luma/api-contract';
import { localeNames } from '@luma/i18n/locales';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { getLocale, type Locale, locales, setLocale } from '@luma/i18n/runtime';
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
  Languages,
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

import {
  adaptiveAvailabilityOptions,
  viewsOptions,
} from '../features/adaptive/data';
import { ordersOptions, suppliersOptions } from '../features/procurement/data';
import { recordsOptions } from '../features/records/data';
import { returnCasesOptions } from '../features/returns/case-data';
import { usePermissions } from '../kit/identity/permissions';
import { askLuma } from '../lib/assistant-panel';
import { usesCommandKey } from '../lib/keyboard';
import { setThemePreference, type ThemePreference } from '../lib/theme';
import { workspaceDestinations } from './workspace-destinations';

const subscribePlatform = () => () => undefined;
const platformModifier = () => (usesCommandKey() ? '⌘' : 'Ctrl');

type Command = {
  id: string;
  label: () => string;
  description: () => string;
  Icon: LucideIcon;
  /** Extra search terms in the active language, separated by spaces. */
  keywords: () => string;
} & (
  | { kind: 'theme'; theme: ThemePreference }
  | { kind: 'language'; locale: Locale }
  | { kind: 'assistant' }
  | { kind: 'link'; render: (children: ReactNode) => ReactNode }
);

const recordKinds = {
  order: m.identity_search_kind_order,
  fulfillment: m.identity_search_kind_fulfillment,
  position: m.identity_search_kind_position,
  sku: m.identity_search_kind_sku,
  product: m.identity_search_kind_product,
  issue: m.identity_search_kind_issue,
} satisfies Record<RecordKind, () => string>;

const languageCommands: Command[] = locales.map((locale) => ({
  id: `language-${locale}`,
  kind: 'language',
  locale,
  label: () => m.identity_command_language({ language: localeNames[locale] }),
  description: () =>
    m.identity_command_language_description({
      language: localeNames[locale],
    }),
  Icon: Languages,
  keywords: m.identity_command_language_keywords,
}));

const commands: Command[] = [
  {
    id: 'assistant',
    kind: 'assistant',
    label: m.identity_command_assistant,
    description: m.identity_command_assistant_description,
    Icon: Sparkles,
    keywords: m.identity_command_assistant_keywords,
  },
  {
    id: 'theme-light',
    kind: 'theme',
    theme: 'light',
    label: m.identity_command_theme_light,
    description: m.identity_command_theme_light_description,
    Icon: Sun,
    keywords: m.identity_command_theme_light_keywords,
  },
  {
    id: 'theme-dark',
    kind: 'theme',
    theme: 'dark',
    label: m.identity_command_theme_dark,
    description: m.identity_command_theme_dark_description,
    Icon: Moon,
    keywords: m.identity_command_theme_dark_keywords,
  },
  {
    id: 'theme-system',
    kind: 'theme',
    theme: 'system',
    label: m.identity_command_theme_system,
    description: m.identity_command_theme_system_description,
    Icon: Monitor,
    keywords: m.identity_command_theme_system_keywords,
  },
  ...languageCommands,
  {
    id: 'workspace-new',
    kind: 'link',
    label: m.identity_command_workspace_new,
    description: m.identity_command_workspace_new_description,
    Icon: Plus,
    keywords: m.identity_command_workspace_new_keywords,
    render: (children) => <Link to="/app/workspaces/new">{children}</Link>,
  },
  {
    id: 'docs',
    kind: 'link',
    label: m.identity_command_docs,
    description: m.identity_command_docs_description,
    Icon: BookOpen,
    keywords: m.identity_command_docs_keywords,
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
  const { can, ready } = usePermissions(organizationId);
  const adaptive = useQuery(adaptiveAvailabilityOptions(organizationId));
  const savedViews = useQuery({
    ...viewsOptions(organizationId),
    enabled: open && adaptive.data?.views === true && ready,
  });
  const matchedViews =
    savedViews.data?.items
      .filter(
        (view) =>
          !view.archived && matches(query, `${view.name} ${view.description}`),
      )
      .slice(0, 8) ?? [];
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
  const returnCases = useQuery({
    ...returnCasesOptions(organizationId, { q: recordQuery, limit: 5 }),
    enabled: open && recordQuery.length >= 2 && can('returns.read'),
  });

  // Procurement records are Luma-owned, so they are searched here rather than in Records.
  const purchasing = open && recordQuery.length >= 2 && can('procurement.read');
  const procurementOrders = useQuery({
    ...ordersOptions(organizationId, { q: recordQuery, limit: 5 }),
    enabled: purchasing,
  });
  const procurementSuppliers = useQuery({
    ...suppliersOptions(organizationId, { q: recordQuery, limit: 3 }),
    enabled: purchasing,
  });
  const purchaseResults = purchasing
    ? [
        ...(procurementSuppliers.data?.items ?? []).map((s) => ({
          key: `supplier:${s.id}`,
          label: s.name,
          detail: m.identity_search_supplier(),
          supplierId: s.id,
        })),
        ...(procurementOrders.data?.items ?? []).map((o) => ({
          key: `purchase_order:${o.id}`,
          label: o.reference,
          detail: m.identity_search_purchase_order({
            supplier: o.supplierName,
          }),
          purchaseOrderId: o.id,
        })),
      ]
    : [];
  const pages = workspaceDestinations.filter(
    (item) =>
      (item.path !== 'views' || adaptive.data?.views === true) &&
      (!item.permission || can(item.permission)) &&
      matches(query, `${item.label} ${item.description}`),
  );
  // Any longer query can become a question for Luma.
  const question =
    query.trim().length >= 3 && can('assistant.use') ? query.trim() : '';
  const locale = getLocale();
  const offered = commands.filter(
    (item) =>
      (item.kind !== 'assistant' || can('assistant.use')) &&
      (item.kind !== 'language' || item.locale !== locale),
  );
  const actions = query.trim()
    ? offered.filter(
        (item) =>
          (item.kind === 'assistant' && question) ||
          matches(
            query,
            `${item.label()} ${item.description()} ${item.keywords()}`,
          ),
      )
    : offered;
  const focusable = () =>
    Array.from(
      results.current?.querySelectorAll<HTMLElement>('a, button') ?? [],
    );

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        className="sidebar-search"
        aria-label={m.identity_search_trigger()}
      >
        <Search size={15} aria-hidden="true" />
        <span className="sidebar-search-label">{m.common_search()}</span>
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
          {m.identity_search_title()}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {m.identity_search_description()}
        </DialogDescription>
        <div className="command-input-row">
          <Search size={17} aria-hidden="true" />
          <input
            ref={input}
            aria-label={m.identity_search_input_label()}
            placeholder={m.identity_search_placeholder()}
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
          aria-label={m.identity_search_results_label()}
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
          {matchedViews.length ? (
            <p className="command-section-label">{m.adaptive_title()}</p>
          ) : null}
          {matchedViews.map((view) => (
            <Link
              key={view.id}
              className="command-item"
              to="/app/$organizationId/views/$viewId"
              params={{ organizationId, viewId: view.id }}
              search={{}}
              onClick={() => changeOpen(false)}
            >
              <span className="command-item-icon">
                <Search size={16} aria-hidden="true" />
              </span>
              <span className="command-item-copy">
                <strong>{view.name}</strong>
                <span>{view.description}</span>
              </span>
            </Link>
          ))}
          {pages.length ? (
            <p className="command-section-label">
              {m.identity_search_section_pages()}
            </p>
          ) : null}
          {pages.map(
            ({ path, label, Icon, description, domain, shortcut, search }) => (
              <Link
                key={path}
                className="command-item"
                to={`/app/$organizationId/${path}`}
                params={{ organizationId }}
                search={search ?? {}}
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
            ),
          )}
          {recordQuery.length >= 2 ? (
            <p className="command-section-label">
              {m.identity_search_section_records()}
            </p>
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
                  {recordKinds[record.kind]()} · {record.description}
                  {record.sources.length
                    ? ` · ${[...new Set(record.sources.map((source) => source.label))].join(' · ')}`
                    : ''}
                </span>
              </span>
              <CornerDownLeft
                className="command-item-enter"
                size={14}
                aria-hidden="true"
              />
            </Link>
          ))}
          {returnCases.data?.items.map((item) => (
            <Link
              key={`return-case:${item.id}`}
              className="command-item"
              to="/app/$organizationId/returns/cases/$caseId"
              params={{ organizationId, caseId: item.id }}
              onClick={() => changeOpen(false)}
            >
              <span className="command-item-icon">
                <DomainIcon domain="returns" size="sm" />
              </span>
              <span className="command-item-copy">
                <strong>
                  {m.returns_case_title({
                    order: item.orderNumber ?? item.orderId.slice(0, 8),
                  })}
                </strong>
                <span>{m.returns_service_cases()}</span>
              </span>
            </Link>
          ))}
          {returnCases.isError && can('returns.read') ? (
            <p role="status">{m.returns_case_load_failed()}</p>
          ) : null}
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
              {m.identity_search_records_searching()}
            </p>
          ) : null}
          {actions.length ? (
            <p className="command-section-label">
              {m.identity_search_section_actions()}
            </p>
          ) : null}
          {actions.map((command) => {
            const content = (
              <>
                <span className="command-item-icon">
                  <command.Icon size={16} aria-hidden="true" />
                </span>
                <span className="command-item-copy">
                  <strong>{command.label()}</strong>
                  <span>
                    {command.kind === 'assistant' && question
                      ? m.identity_search_ask_question({ question })
                      : command.description()}
                  </span>
                </span>
                <CornerDownLeft
                  className="command-item-enter"
                  size={14}
                  aria-hidden="true"
                />
              </>
            );

            return command.kind === 'link' ? (
              <span
                key={command.id}
                className="command-item-link"
                onClickCapture={() => changeOpen(false)}
              >
                {command.render(content)}
              </span>
            ) : (
              <button
                key={command.id}
                type="button"
                className="command-item"
                onClick={() => {
                  if (command.kind === 'theme')
                    setThemePreference(command.theme);
                  else if (command.kind === 'language')
                    void setLocale(command.locale);
                  else {
                    handoff.current = true;
                    askLuma(question);
                  }
                  changeOpen(false);
                }}
              >
                {content}
              </button>
            );
          })}
          {!matchedViews.length &&
          !pages.length &&
          !actions.length &&
          !records.data?.items.length &&
          !purchaseResults.length ? (
            <div className="command-empty" role="status">
              <Search size={20} aria-hidden="true" />
              <strong>{m.identity_search_empty_title()}</strong>
              <span>{m.identity_search_empty_hint()}</span>
            </div>
          ) : null}
        </nav>
        <footer className="command-footer">
          <span>
            <ArrowUp size={12} aria-hidden="true" />
            <ArrowDown size={12} aria-hidden="true" />{' '}
            {m.identity_search_footer_move()}
          </span>
          <span>
            <CornerDownLeft size={12} aria-hidden="true" />{' '}
            {m.identity_search_footer_open()}
          </span>
          <span className="command-footer-hint">
            {rich(m.identity_search_footer_hint, { key: <Kbd>G</Kbd> })}
          </span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
