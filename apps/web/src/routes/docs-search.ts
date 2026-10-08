import '@tanstack/react-start';

import { baseLocale, getLocale, isLocale } from '@luma/i18n/runtime';
import { createFileRoute } from '@tanstack/react-router';
import { createFromSource } from 'fumadocs-core/search/server';

import { docSection, source } from '../features/help/source';

// One index holds every language, filtered by locale per query. Pages share canonical URLs
// across languages, so document IDs include the language.
const search = createFromSource(source, {
  buildIndex: async (page) => {
    const locale = isLocale(page.locale) ? page.locale : baseLocale;
    const section = docSection(page.slugs.join('/'), locale);

    return {
      id: `${locale}:${page.url}`,
      url: page.url,
      title: page.data.title,
      ...(page.data.description ? { description: page.data.description } : {}),
      structuredData: await page.data.structuredData(),
      breadcrumbs: section ? [section, page.data.title] : [page.data.title],
    };
  },
});

export const Route = createFileRoute('/docs-search')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams;
        const query = params.get('query');
        if (!query) return Response.json([]);

        const requested = params.get('locale');
        const locale = isLocale(requested) ? requested : getLocale();

        return Response.json(await search.search(query, { locale }));
      },
    },
  },
});
