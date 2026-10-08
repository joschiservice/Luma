import { m } from '@luma/i18n/messages';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';

import { DocsPortal } from '../features/help/portal';
import { docPage } from '../features/help/source';

export const Route = createFileRoute('/docs/$')({
  loader: async ({ params }) => {
    const slug = params._splat ?? '';
    const page = docPage(slug)?.page;
    if (!page) throw notFound();
    await page.data.preload();

    return { slug, title: page.data.title, description: page.data.description };
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.title ?? m.docs_title()} · Luma` },
      {
        name: 'description',
        content: loaderData?.description ?? m.docs_meta_description(),
      },
    ],
  }),
  component: Documentation,
  notFoundComponent: () => (
    <main className="docs-missing">
      <h1>{m.docs_missing_title()}</h1>
      <p>{m.docs_missing_body()}</p>
      <Link to="/docs">{m.docs_missing_link()}</Link>
    </main>
  ),
});

function Documentation() {
  const { slug } = Route.useLoaderData();

  return <DocsPortal slug={slug} />;
}
