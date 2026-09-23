import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@luma/ui/components/dialog';
import { Input } from '@luma/ui/components/input';
import { Link } from '@tanstack/react-router';
import { Activity, Inbox, LayoutDashboard, Search, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';

const destinations = [
  { path: 'overview', label: 'Overview', Icon: LayoutDashboard },
  { path: 'exceptions', label: 'Issues', Icon: Inbox },
  { path: 'activity', label: 'Activity', Icon: Activity },
  { path: 'connections', label: 'Connections', Icon: Unplug },
] as const;

/** Opens workspace navigation search with the keyboard shortcut or search button. */
export function WorkspaceSearch({
  organizationId,
}: {
  organizationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const matches = destinations.filter((item) =>
    item.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setQuery('');
      }}
    >
      <DialogTrigger className="workspace-search-trigger">
        <Search size={16} aria-hidden="true" />
        <span>Search</span>
        <kbd>⌘ K</kbd>
      </DialogTrigger>
      <DialogContent className="command-palette">
        <DialogTitle>Go to a page</DialogTitle>
        <DialogDescription>Find a page in your workspace.</DialogDescription>
        <Input
          aria-label="Search pages"
          placeholder="Search pages…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <nav aria-label="Search results" className="command-results">
          {matches.map(({ path, label, Icon }) => (
            <Link
              key={path}
              to={`/app/$organizationId/${path}`}
              params={{ organizationId }}
              onClick={() => setOpen(false)}
            >
              <Icon size={18} aria-hidden="true" />
              {label}
            </Link>
          ))}
          {!matches.length && <p role="status">No pages match your search.</p>}
        </nav>
      </DialogContent>
    </Dialog>
  );
}
