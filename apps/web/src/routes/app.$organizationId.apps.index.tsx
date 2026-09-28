import { createFileRoute } from '@tanstack/react-router';

import { appResultSearch } from '../features/apps/data';
import { ConnectionsPage } from '../features/connections/page';

export const Route = createFileRoute('/app/$organizationId/apps/')({
  validateSearch: appResultSearch,
  component: ConnectionsPage,
});
