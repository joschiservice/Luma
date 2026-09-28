import { createFileRoute } from '@tanstack/react-router';

import {
  NewWorkflowPage,
  parseGallerySearch,
} from '../features/workflows/authoring/gallery';

export const Route = createFileRoute('/app/$organizationId/workflows/new')({
  validateSearch: parseGallerySearch,
  staticData: { help: 'workflows/create' },
  component: NewWorkflowPage,
});
