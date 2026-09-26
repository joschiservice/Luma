import { createFileRoute, redirect } from '@tanstack/react-router';

import { parseWorkflowFilters } from '../features/workflows/library';

export const Route = createFileRoute(
  '/app/$organizationId/playbooks/$definitionId',
)({
  validateSearch: parseWorkflowFilters,
  beforeLoad: ({ params, search, location }) => {
    throw redirect({
      to: '/app/$organizationId/workflows/$definitionId',
      params,
      search,
      hash: location.hash,
      replace: true,
    });
  },
});
