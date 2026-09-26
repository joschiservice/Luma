import { Link } from '@tanstack/react-router';
import type { MDXComponents } from 'mdx/types';
import { use, useEffect, useRef } from 'react';

import { docLocation } from './context';
import { source } from './source';

function focusHeading(root: HTMLElement | null, hash: string) {
  const heading = hash
    ? Array.from(root?.querySelectorAll<HTMLElement>('[id]') ?? []).find(
        (node) => node.id === `help-${hash}`,
      )
    : root?.querySelector<HTMLElement>('[data-article-title]');
  if (hash) heading?.scrollIntoView({ block: 'start' });
  else root?.closest('.help-scroll')?.scrollTo({ top: 0 });
  heading?.focus({ preventScroll: true });
}

/** Renders a shared MDX article and keeps embedded links and heading navigation in the drawer. */
export function DocArticle({
  slug,
  hash = '',
  onNavigate,
}: {
  slug: string;
  hash?: string;
  onNavigate?: (href: string) => void;
}) {
  const page = source.getPage(slug.split('/'));
  const root = useRef<HTMLElement>(null);
  const embedded = Boolean(onNavigate);
  const content = page ? use(page.data.load()) : undefined;

  useEffect(() => {
    if (!embedded) return;
    focusHeading(root.current, hash);
  }, [slug, hash, embedded]);

  function navigate(href: string) {
    const target = docLocation(href);
    if (target?.slug === slug) focusHeading(root.current, target.hash);
    onNavigate?.(href);
  }

  if (!page || !content)
    return (
      <p>
        This guide could not be found. <a href="/docs">Browse documentation</a>.
      </p>
    );
  const Body = page.data.body;
  const Title = embedded ? 'h2' : 'h1';
  const components: MDXComponents = {
    a: ({ href = '', children, ...props }) => {
      const location = docLocation(href);
      if (embedded && (location || href.startsWith('#')))
        return (
          <a
            {...props}
            href={location ? href : `${page.url}${href}`}
            onClick={(event) => {
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              navigate(location ? href : `${page.url}${href}`);
            }}
          >
            {children}
          </a>
        );
      if (location)
        return (
          <Link
            {...props}
            to="/docs/$"
            params={{ _splat: location.slug }}
            hash={location.hash}
          >
            {children}
          </Link>
        );

      return (
        <a {...props} href={href}>
          {children}
        </a>
      );
    },
    h2: ({ id, ...props }) =>
      embedded ? (
        <h3 {...props} id={`help-${id}`} tabIndex={-1} />
      ) : (
        <h2 {...props} id={id} />
      ),
    h3: ({ id, ...props }) =>
      embedded ? (
        <h4 {...props} id={`help-${id}`} tabIndex={-1} />
      ) : (
        <h3 {...props} id={id} />
      ),
  };

  return (
    <article className="docs-article" ref={root}>
      <p className="docs-eyebrow">Issues · Guide</p>
      <Title data-article-title tabIndex={-1}>
        {page.data.title}
      </Title>
      <p className="docs-description">{page.data.description}</p>
      {content.toc.length ? (
        <nav className="docs-toc" aria-label="On this page">
          <span>On this page</span>
          {content.toc.map((item) => (
            <a
              key={item.url}
              href={embedded ? `${page.url}${item.url}` : item.url}
              onClick={
                embedded
                  ? (event) => {
                      if (
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      navigate(`${page.url}${item.url}`);
                    }
                  : undefined
              }
            >
              {item.title}
            </a>
          ))}
        </nav>
      ) : null}
      <div className="docs-prose">
        <Body components={components} />
      </div>
    </article>
  );
}
