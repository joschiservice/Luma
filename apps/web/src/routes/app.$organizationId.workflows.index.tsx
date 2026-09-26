import { createFileRoute } from '@tanstack/react-router';

import {
  parseWorkflowFilters,
  WorkflowsPage,
} from '../features/workflows/library';

export const Route = createFileRoute('/app/$organizationId/workflows/')({
  validateSearch: parseWorkflowFilters,
  component: WorkflowsPage,
});
