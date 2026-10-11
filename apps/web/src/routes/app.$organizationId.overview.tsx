import { createFileRoute, redirect } from '@tanstack/react-router';

import { homeSearch } from '../kit/home/preferences';

export const Route = createFileRoute('/app/$organizationId/overview')({
  validateSearch: homeSearch,
  beforeLoad: ({ params, search, location }) => {
    throw redirect({
      to: '/app/$organizationId/home',
      params,
      search,
      hash: location.hash,
      replace: true,
    });
  },
});
