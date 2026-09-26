import { Input } from '@luma/ui/components/primitives/input';
import { Link, useHydrated } from '@tanstack/react-router';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { fetchClient } from 'fumadocs-core/search/client/fetch';
import { Search } from 'lucide-react';
import { useId } from 'react';

import { docLocation } from './context';

const client = fetchClient({ api: '/docs-search' });

/** Searches article text and opens results in the portal or the enclosing help drawer. */
export function DocsSearch({
  onNavigate,
}: {
  onNavigate?: (href: string) => void;
}) {
  const { search, setSearch, query } = useDocsSearch({ client });
  const id = useId();
  const hydrated = useHydrated();
  const results = Array.isArray(query.data) ? query.data.slice(0, 8) : [];

  return (
    <div className="docs-search" role="search" aria-label="Documentation">
      <div className="docs-search-input">
        <Search size={16} aria-hidden="true" />
        <Input
          aria-label="Search documentation"
          type="search"
          placeholder="Search documentation…"
          disabled={!hydrated}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-controls={search.trim() ? id : undefined}
        />
      </div>
      {search.trim() ? (
        <div id={id} className="docs-search-results">
          <p role="status">
            {query.error
              ? 'Search is unavailable. Browse the guides below.'
              : query.isLoading
                ? 'Searching…'
                : results.length
                  ? `${results.length} results`
                  : 'No results. Try another word, or browse the guides below.'}
          </p>
          {!query.isLoading && !query.error ? (
            <ul>
              {results.map((result) => {
                const location = docLocation(result.url);
                if (!location) return null;

                return (
                  <li key={result.id}>
                    <Link
                      to="/docs/$"
                      params={{ _splat: location.slug }}
                      hash={location.hash}
                      onClick={(event) => {
                        if (
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return;
                        if (onNavigate) {
                          event.preventDefault();
                          onNavigate(result.url);
                        }
                        setSearch('');
                      }}
                    >
                      {result.breadcrumbs?.length ? (
                        <small>
                          {result.breadcrumbs
                            .join(' / ')
                            .replaceAll(/<\/?mark>/g, '')}
                        </small>
                      ) : null}
                      <span>
                        {result.content.replaceAll(/<\/?mark>|\*\*/g, '')}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
