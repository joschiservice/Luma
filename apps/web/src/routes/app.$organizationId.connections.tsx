import { createFileRoute, redirect } from '@tanstack/react-router';

import { appResultSearch } from '../kit/apps/data';

export const Route = createFileRoute('/app/$organizationId/connections')({
  validateSearch: appResultSearch,
  beforeLoad: ({ params, search, location }) => {
    throw redirect({
      to: '/app/$organizationId/apps',
      params,
      search,
      hash: location.hash,
      replace: true,
    });
  },
});
