import { createFileRoute } from '@tanstack/react-router';
import { Inbox } from '../features/exceptions/page';
import { inboxSearch } from '../features/exceptions/data';
export const Route = createFileRoute('/app/$organizationId/exceptions')({
  validateSearch: inboxSearch,
  component: Inbox,
});
