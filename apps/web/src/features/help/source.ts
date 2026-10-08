import {
  baseLocale,
  getLocale,
  type Locale,
  locales,
} from '@luma/i18n/runtime';
import { defineI18n } from 'fumadocs-core/i18n';
import { loader } from 'fumadocs-core/source';
import { defineDocs } from 'fumadocs-mdx/macro';

const docs = defineDocs({ dir: 'content/docs', docs: { async: true } });

/**
 * Guides use the interface languages. A translation sits beside its English guide with the
 * language before the extension (`orders.de.mdx`); English is shown when it is missing.
 */
export const docsI18n = defineI18n({
  languages: [...locales],
  defaultLanguage: baseLocale,
  parser: 'dot',
  fallbackLanguage: baseLocale,
});

/** Every language shares the canonical `/docs/<slug>` URL; the reader's language picks the text. */
export const source = loader({
  baseUrl: '/docs',
  i18n: docsI18n,
  url: (slugs) => `/docs/${slugs.join('/')}`,
  source: docs.toFumadocsSource(),
});

export type DocPage = NonNullable<ReturnType<typeof source.getPage>>;

/**
 * Finds a guide in the reader's language. `translated` is false when the language has no
 * translation and the English guide is shown instead.
 */
export function docPage(slug: string, locale: Locale = getLocale()) {
  const slugs = slug.split('/');
  const page = source.getPage(slugs, locale);
  if (!page) return undefined;

  const translated =
    locale === baseLocale ||
    page.path !== source.getPage(slugs, baseLocale)?.path;

  return { page, translated };
}

export interface DocGuide {
  slug: string;
  url: string;
  title: string;
  description?: string | undefined;
  /** True when the guide's parent, such as `issues` for `issues/resolve`, is in the same section. */
  nested: boolean;
}

export interface DocSection {
  title: string;
  guides: DocGuide[];
}

const sectionCache = new Map<Locale, DocSection[]>();

/**
 * Lists the guide sections in the order and with the titles of the language's `meta.json`.
 * Sections without guides are left out.
 */
export function docSections(locale: Locale = getLocale()): DocSection[] {
  const cached = sectionCache.get(locale);
  if (cached) return cached;

  const sections: DocSection[] = [];
  for (const node of source.getPageTree(locale).children) {
    if (node.type === 'separator') {
      sections.push({ title: String(node.name ?? ''), guides: [] });
      continue;
    }
    if (node.type !== 'page' || node.external) continue;

    const slug = node.url.replace(/^\/docs\//, '');
    if (!sections.length) sections.push({ title: '', guides: [] });
    const { guides } = sections.at(-1)!;
    guides.push({
      slug,
      url: node.url,
      title: String(node.name),
      description:
        typeof node.description === 'string' ? node.description : undefined,
      nested: guides.some((guide) => guide.slug === slug.split('/')[0]),
    });
  }

  const result = sections.filter((section) => section.guides.length);
  sectionCache.set(locale, result);

  return result;
}

/** Names the section a guide belongs to, or undefined for a guide outside the navigation. */
export function docSection(slug: string, locale: Locale = getLocale()) {
  return docSections(locale).find((section) =>
    section.guides.some((guide) => guide.slug === slug),
  )?.title;
}
