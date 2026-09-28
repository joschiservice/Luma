import { createFileRoute } from '@tanstack/react-router';

import {
  DraftEditorPage,
  parseEditorSearch,
} from '../features/workflows/authoring/editor';

export const Route = createFileRoute(
  '/app/$organizationId/workflows/drafts/$draftId',
)({
  validateSearch: parseEditorSearch,
  staticData: { help: 'workflows/create' },
  component: DraftEditorPage,
});
