import { createFileRoute } from '@tanstack/react-router';

import { inboxSearch } from '../features/exceptions/data';
import { Inbox } from '../features/exceptions/page';

export const Route = createFileRoute('/app/$organizationId/exceptions')({
  validateSearch: inboxSearch,
  component: Inbox,
});
