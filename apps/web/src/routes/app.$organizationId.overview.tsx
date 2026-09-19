import { createFileRoute } from '@tanstack/react-router';
import { OverviewPage } from '../features/overview/page';
import { overviewSearch } from '../features/overview/data';
export const Route = createFileRoute('/app/$organizationId/overview')({
  validateSearch: overviewSearch,
  component: OverviewPage,
});
