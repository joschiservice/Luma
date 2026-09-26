import { createFileRoute, redirect } from '@tanstack/react-router';

import { parseWorkflowFilters } from '../features/workflows/library';

export const Route = createFileRoute('/app/$organizationId/playbooks/')({
  validateSearch: parseWorkflowFilters,
  beforeLoad: ({ params, search, location }) => {
    throw redirect({
      to: '/app/$organizationId/workflows',
      params,
      search,
      hash: location.hash,
      replace: true,
    });
  },
});
