import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@luma/ui/components/primitives/dialog';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Kbd } from '@luma/ui/components/primitives/kbd';
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
  Sun,
} from 'lucide-react';
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { usesCommandKey } from '../../lib/keyboard';
import { setThemePreference, type ThemePreference } from '../../lib/theme';
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
  | { kind: 'link'; render: (children: ReactNode) => ReactNode }
);

const commands: Command[] = [
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
  const modifier = useSyncExternalStore(
    subscribePlatform,
    platformModifier,
    () => 'Ctrl',
  );
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLElement>(null);

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

  const pages = workspaceDestinations.filter((item) =>
    matches(query, `${item.label} ${item.description}`),
  );
  const actions = query.trim()
    ? commands.filter((item) =>
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
            aria-label="Search pages"
            placeholder="Search pages and actions…"
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
                  <span>{command.description}</span>
                </span>
                <CornerDownLeft
                  className="command-item-enter"
                  size={14}
                  aria-hidden="true"
                />
              </>
            );

            return command.kind === 'theme' ? (
              <button
                key={command.id}
                type="button"
                className="command-item"
                onClick={() => {
                  setThemePreference(command.theme);
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
          {!pages.length && !actions.length ? (
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
