import { m } from '@luma/i18n/messages';
import { getLocale } from '@luma/i18n/runtime';
import { Input } from '@luma/ui/components/primitives/input';
import { Link, useHydrated } from '@tanstack/react-router';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { fetchClient } from 'fumadocs-core/search/client/fetch';
import { Search } from 'lucide-react';
import { useId, useMemo } from 'react';

import { docLocation } from './context';

/**
 * Searches article text in the reader's language and opens results in the portal or the
 * enclosing help drawer.
 */
export function DocsSearch({
  onNavigate,
}: {
  onNavigate?: (href: string) => void;
}) {
  const locale = getLocale();
  const client = useMemo(
    () => fetchClient({ api: '/docs-search', locale }),
    [locale],
  );
  const { search, setSearch, query } = useDocsSearch({ client });
  const id = useId();
  const hydrated = useHydrated();
  const results = Array.isArray(query.data) ? query.data.slice(0, 8) : [];

  return (
    <div className="docs-search" role="search" aria-label={m.docs_title()}>
      <div className="docs-search-input">
        <Search size={16} aria-hidden="true" />
        <Input
          aria-label={m.docs_search_label()}
          type="search"
          placeholder={m.docs_search_placeholder()}
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
              ? m.docs_search_unavailable()
              : query.isLoading
                ? m.docs_search_searching()
                : results.length
                  ? m.docs_search_results({ count: results.length })
                  : m.docs_search_empty()}
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
