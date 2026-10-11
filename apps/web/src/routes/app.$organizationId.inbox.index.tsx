import { createFileRoute } from '@tanstack/react-router';

import { inboxSearch } from '../features/inbox/data';
import { InboxPage } from '../features/inbox/page';

export const Route = createFileRoute('/app/$organizationId/inbox/')({
  validateSearch: inboxSearch,
  staticData: { help: 'inbox' },
  component: InboxPage,
});
