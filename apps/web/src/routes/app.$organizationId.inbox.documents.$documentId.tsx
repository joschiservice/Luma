import { createFileRoute } from '@tanstack/react-router';

import { DocumentReviewPage } from '../features/inbox/document';

export const Route = createFileRoute(
  '/app/$organizationId/inbox/documents/$documentId',
)({
  staticData: { help: 'inbox' },
  component: DocumentReviewPage,
});
