import '@tanstack/react-start';

import { createFileRoute } from '@tanstack/react-router';
import { createFromSource } from 'fumadocs-core/search/server';

import { source } from '../features/help/source';

const search = createFromSource(source);

export const Route = createFileRoute('/docs-search')({
  server: { handlers: { GET: ({ request }) => search.GET(request) } },
});
