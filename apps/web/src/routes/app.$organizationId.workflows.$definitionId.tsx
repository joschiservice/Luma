import { createFileRoute } from '@tanstack/react-router';

import { WorkflowPage } from '../features/workflows/detail';
import { parseWorkflowFilters } from '../features/workflows/library';

export const Route = createFileRoute(
  '/app/$organizationId/workflows/$definitionId',
)({ validateSearch: parseWorkflowFilters, component: WorkflowPage });
