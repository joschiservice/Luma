import { createFileRoute } from '@tanstack/react-router';

import { InsightsPage } from '../features/overview/insights';

export const Route = createFileRoute('/app/$organizationId/insights')({
  component: InsightsPage,
});
