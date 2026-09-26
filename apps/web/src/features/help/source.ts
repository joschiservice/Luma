import { loader } from 'fumadocs-core/source';
import { defineDocs } from 'fumadocs-mdx/macro';

const docs = defineDocs({ dir: 'content/docs', docs: { async: true } });

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});

export const guides = source
  .getPages()
  .sort((a, b) => a.url.localeCompare(b.url));
