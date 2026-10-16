import { createFileRoute } from '@tanstack/react-router';

import { insightsSearch } from '../features/insights/data';
import { InsightsPage } from '../features/insights/page';

export const Route = createFileRoute('/app/$organizationId/insights')({
  validateSearch: insightsSearch,
  staticData: { help: 'insights' },
  component: InsightsPage,
});
