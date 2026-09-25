import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@luma/ui/components/primitives/dialog';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, CornerDownLeft, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { workspaceDestinations } from './workspace-destinations';

const subscribePlatform = () => () => undefined;
const platformShortcut = () =>
  /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';

/** Opens page search with pointer or keyboard navigation and restores focus on dismissal. */
export function WorkspaceSearch({
  organizationId,
}: {
  organizationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const shortcut = useSyncExternalStore(
    subscribePlatform,
    platformShortcut,
    () => 'Ctrl K',
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
  const matches = workspaceDestinations.filter((item) =>
    `${item.label} ${item.description}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        className="workspace-search-trigger"
        aria-label="Search pages"
      >
        <Search size={16} aria-hidden="true" />
        <span>Search pages…</span>
        <kbd>{shortcut}</kbd>
      </DialogTrigger>
      <DialogContent
        className="command-palette"
        showCloseButton={false}
        initialFocus={input}
      >
        <DialogTitle className="sr-only">Search pages</DialogTitle>
        <DialogDescription className="sr-only">
          Find a page in your workspace. Use the arrow keys to browse results
          and Enter to open a page.
        </DialogDescription>
        <div className="command-input-row">
          <Search size={20} aria-hidden="true" />
          <input
            ref={input}
            aria-label="Search pages"
            placeholder="Where would you like to go?"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              const links = results.current?.querySelectorAll('a');
              if (!links?.length) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                links[
                  event.key === 'ArrowDown' ? 0 : links.length - 1
                ]?.focus();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                links[0]?.click();
              }
            }}
          />
          <DialogClose className="command-close" aria-label="Close search">
            <X size={16} aria-hidden="true" />
          </DialogClose>
        </div>
        <div className="command-section-label">Workspace pages</div>
        <nav
          ref={results}
          aria-label="Search results"
          className="command-results"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const links = Array.from(event.currentTarget.querySelectorAll('a'));
            const index = links.indexOf(event.target as HTMLAnchorElement);
            const next = index + (event.key === 'ArrowDown' ? 1 : -1);
            if (next < 0 || next >= links.length) input.current?.focus();
            else links[next]?.focus();
          }}
        >
          {matches.map(({ path, label, Icon, description }) => (
            <Link
              key={path}
              to={`/app/$organizationId/${path}`}
              params={{ organizationId }}
              onClick={() => changeOpen(false)}
            >
              <span className="command-result-icon">
                <Icon size={18} aria-hidden="true" />
              </span>
              <span className="command-result-copy">
                <strong>{label}</strong>
                <span>{description}</span>
              </span>
              <CornerDownLeft
                className="command-result-enter"
                size={16}
                aria-hidden="true"
              />
            </Link>
          ))}
          {!matches.length && (
            <div className="command-empty" role="status">
              <Search size={24} aria-hidden="true" />
              <strong>No pages found</strong>
              <span>Try Issues, Playbooks, or Connections.</span>
            </div>
          )}
        </nav>
        <footer className="command-footer">
          <span>
            <ArrowUp size={12} />
            <ArrowDown size={12} /> Navigate
          </span>
          <span>
            <CornerDownLeft size={12} /> Open
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
