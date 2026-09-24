import { createFileRoute } from '@tanstack/react-router';

import { inboxSearch } from '../features/exceptions/data';
import { IssueDetailPage } from '../features/exceptions/detail-page';

export const Route = createFileRoute(
  '/app/$organizationId/exceptions_/$exceptionId/detail',
)({
  validateSearch: inboxSearch,
  component: IssueDetailPage,
});
