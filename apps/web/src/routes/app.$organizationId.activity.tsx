import { createFileRoute } from '@tanstack/react-router';

import { parseActivityFilters } from '../features/activity/data';
import { ActivityPage } from '../features/activity/page';

export const Route = createFileRoute('/app/$organizationId/activity')({
  validateSearch: parseActivityFilters,
  component: ActivityPage,
});
