import { createFileRoute, Link, notFound } from '@tanstack/react-router';

import { DocsPortal } from '../features/help/portal';
import { source } from '../features/help/source';

export const Route = createFileRoute('/docs/$')({
  loader: async ({ params }) => {
    const slug = params._splat ?? '';
    const page = source.getPage(slug.split('/'));
    if (!page) throw notFound();
    await page.data.preload();

    return { slug, title: page.data.title, description: page.data.description };
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.title ?? 'Documentation'} · Luma` },
      {
        name: 'description',
        content: loaderData?.description ?? 'Luma documentation',
      },
    ],
  }),
  component: Documentation,
  notFoundComponent: () => (
    <main className="docs-missing">
      <h1>Guide not found</h1>
      <p>This documentation page does not exist.</p>
      <Link to="/docs/$" params={{ _splat: 'issues' }}>
        Browse issue guides
      </Link>
    </main>
  ),
});

function Documentation() {
  const { slug } = Route.useLoaderData();

  return <DocsPortal slug={slug} />;
}
