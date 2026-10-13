import { createFileRoute } from '@tanstack/react-router';

import { viewsSearch } from '../features/adaptive/data';
import { ViewsPage } from '../features/adaptive/page';

export const Route = createFileRoute('/app/$organizationId/views/')({
  validateSearch: viewsSearch,
  staticData: { help: 'saved-views' },
  component: ViewsPage,
});
