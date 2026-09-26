import { Link } from '@tanstack/react-router';
import { ArrowRight, BookOpen } from 'lucide-react';
import { Suspense } from 'react';

import { Brand } from '../identity/common';
import { DocArticle } from './article';
import { DocsSearch } from './search';
import { guides } from './source';

/** Displays the documentation portal with article navigation and shared full-text search. */
export function DocsPortal({ slug }: { slug: string }) {
  return (
    <div className="docs-portal">
      <a className="skip-link" href="#docs-content">
        Skip to documentation
      </a>
      <header className="docs-header">
        <Brand />
        <span>Documentation</span>
        <Link to="/app">
          Open Luma <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </header>
      <div className="docs-layout">
        <aside className="docs-sidebar">
          <DocsSearch />
          <nav aria-label="Documentation">
            <p>
              <BookOpen size={16} aria-hidden="true" /> Working with issues
            </p>
            {guides.map((guide) => (
              <Link
                key={guide.url}
                to="/docs/$"
                params={{ _splat: guide.slugs.join('/') }}
                activeOptions={{ exact: true }}
                aria-current={
                  guide.slugs.join('/') === slug ? 'page' : undefined
                }
              >
                {guide.data.title}
              </Link>
            ))}
          </nav>
        </aside>
        <main id="docs-content" className="docs-content" tabIndex={-1}>
          <Suspense fallback={<p role="status">Loading guide…</p>}>
            <DocArticle slug={slug} />
          </Suspense>
          <div className="docs-endnote">
            <BookOpen size={16} aria-hidden="true" /> You can also open these
            guides from Help on any issues page.
          </div>
        </main>
      </div>
    </div>
  );
}
