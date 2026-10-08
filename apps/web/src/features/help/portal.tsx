import { m } from '@luma/i18n/messages';
import {
  Card,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { LanguageSelect } from '@luma/ui/components/workspace/language-select';
import { Link } from '@tanstack/react-router';
import { ArrowRight, BookOpen } from 'lucide-react';
import { Suspense } from 'react';

import { Brand } from '../identity/common';
import { DocArticle } from './article';
import { DocsSearch } from './search';
import { docSections } from './source';

/**
 * Displays the public documentation portal with sectioned navigation, full-text search and a
 * language choice. Without a slug it shows the documentation overview.
 */
export function DocsPortal({ slug }: { slug?: string }) {
  const sections = docSections();

  return (
    <div className="docs-portal">
      <a className="skip-link" href="#docs-content">
        {m.docs_portal_skip_link()}
      </a>
      <header className="docs-header">
        <Brand />
        <span>{m.docs_title()}</span>
        <div className="docs-header-actions">
          <LanguageSelect className="docs-language" />
          <Link to="/app">
            {m.docs_portal_open_app()}{' '}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </header>
      <div className="docs-layout">
        <aside className="docs-sidebar">
          <DocsSearch />
          <nav aria-label={m.docs_nav_label()}>
            <Link
              to="/docs"
              activeOptions={{ exact: true }}
              aria-current={slug ? undefined : 'page'}
            >
              <BookOpen size={15} aria-hidden="true" />
              {m.docs_nav_overview()}
            </Link>
            {sections.map((section, index) => (
              <div
                key={section.title}
                role="group"
                aria-labelledby={`docs-nav-section-${index}`}
              >
                <p id={`docs-nav-section-${index}`}>{section.title}</p>
                {section.guides.map((guide) => (
                  <Link
                    key={guide.url}
                    to="/docs/$"
                    params={{ _splat: guide.slug }}
                    activeOptions={{ exact: true }}
                    data-nested={guide.nested || undefined}
                    aria-current={guide.slug === slug ? 'page' : undefined}
                  >
                    {guide.title}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main id="docs-content" className="docs-content" tabIndex={-1}>
          {slug ? (
            <Suspense
              fallback={<p role="status">{m.docs_article_loading()}</p>}
            >
              <DocArticle slug={slug} />
            </Suspense>
          ) : (
            <DocsOverview />
          )}
          <div className="docs-endnote">
            <BookOpen size={16} aria-hidden="true" />
            {m.docs_portal_endnote()}
          </div>
        </main>
      </div>
    </div>
  );
}

function DocsOverview() {
  return (
    <div className="docs-overview">
      <h1>{m.docs_home_title()}</h1>
      <p className="docs-description">{m.docs_home_intro()}</p>
      <div className="docs-overview-sections">
        {docSections().map((section) => (
          <Card key={section.title} as="section">
            <CardHeader>
              <CardTitle>{section.title}</CardTitle>
            </CardHeader>
            <ul>
              {section.guides.map((guide) => (
                <li key={guide.url}>
                  <Link to="/docs/$" params={{ _splat: guide.slug }}>
                    {guide.title}
                  </Link>
                  {guide.description ? <p>{guide.description}</p> : null}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}
