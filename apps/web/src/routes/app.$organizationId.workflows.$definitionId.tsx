import { createFileRoute } from '@tanstack/react-router';

import { WorkflowPage } from '../features/workflows/detail';
import { parseWorkflowDetailSearch } from '../features/workflows/library';

export const Route = createFileRoute(
  '/app/$organizationId/workflows/$definitionId',
)({
  validateSearch: parseWorkflowDetailSearch,
  staticData: { help: 'workflows' },
  component: WorkflowPage,
});
