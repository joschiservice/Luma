import { createFileRoute, redirect } from '@tanstack/react-router';

import { appResultSearch } from '../features/apps/data';

export const Route = createFileRoute('/app/$organizationId/connections')({
  validateSearch: appResultSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: '/app/$organizationId/apps',
      params,
      search,
      replace: true,
    });
  },
});
