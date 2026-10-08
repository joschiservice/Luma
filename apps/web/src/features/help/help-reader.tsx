import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { ArrowLeft, ArrowUpRight, BookOpen } from 'lucide-react';
import { Suspense, useState } from 'react';

import { DocArticle } from './article';
import { docLocation, type HelpTopic } from './context';
import { DocsSearch } from './search';
import { docSections } from './source';

/** Browses documentation independently from the current issue and its URL state. */
export default function HelpReader({ topic }: { topic: HelpTopic }) {
  const [history, setHistory] = useState([`/docs/${topic}`]);
  const href = history.at(-1)!;
  const location = docLocation(href)!;
  const navigate = (next: string) => {
    if (next !== href && docLocation(next))
      setHistory((previous) => [...previous, next]);
  };

  return (
    <>
      <div className="help-tools">
        <DocsSearch onNavigate={navigate} />
        <div className="help-navigation">
          <Button
            variant="ghost"
            size="sm"
            disabled={history.length < 2}
            onClick={() => setHistory((previous) => previous.slice(0, -1))}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            {m.common_back()}
          </Button>
          <a href={href} target="_blank" rel="noreferrer">
            {m.help_open_full()}
            <ArrowUpRight size={14} aria-hidden="true" />
            <span className="sr-only"> {m.help_new_tab()}</span>
          </a>
        </div>
      </div>
      <div className="help-scroll">
        <Suspense
          fallback={
            <p className="help-load-state" role="status">
              {m.docs_article_loading()}
            </p>
          }
        >
          <DocArticle
            slug={location.slug}
            hash={location.hash}
            onNavigate={navigate}
          />
        </Suspense>
        <nav className="help-guides" aria-label={m.help_guides_label()}>
          <p>
            <BookOpen size={15} aria-hidden="true" /> {m.help_guides_heading()}
          </p>
          {docSections().map((section, index) => (
            <div
              key={section.title}
              role="group"
              aria-labelledby={`help-guides-section-${index}`}
            >
              <span id={`help-guides-section-${index}`}>{section.title}</span>
              {section.guides.map((guide) => (
                <a
                  key={guide.url}
                  href={guide.url}
                  data-nested={guide.nested || undefined}
                  aria-current={
                    guide.slug === location.slug ? 'page' : undefined
                  }
                  onClick={(event) => {
                    if (
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    navigate(guide.url);
                  }}
                >
                  {guide.title}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              ))}
            </div>
          ))}
        </nav>
      </div>
    </>
  );
}
