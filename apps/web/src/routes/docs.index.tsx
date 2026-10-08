import { m } from '@luma/i18n/messages';
import { createFileRoute } from '@tanstack/react-router';

import { DocsPortal } from '../features/help/portal';

export const Route = createFileRoute('/docs/')({
  head: () => ({
    meta: [
      { title: `${m.docs_title()} · Luma` },
      { name: 'description', content: m.docs_meta_description() },
    ],
  }),
  component: () => <DocsPortal />,
});
