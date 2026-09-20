import { createFileRoute } from '@tanstack/react-router';

import { overviewSearch } from '../features/overview/data';
import { OverviewPage } from '../features/overview/page';

export const Route = createFileRoute('/app/$organizationId/overview')({
  validateSearch: overviewSearch,
  component: OverviewPage,
});
