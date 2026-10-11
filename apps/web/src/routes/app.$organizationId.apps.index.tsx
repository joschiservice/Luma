import { createFileRoute } from '@tanstack/react-router';

import { ConnectionsPage } from '../features/connections/page';
import { appResultSearch } from '../kit/apps/data';

export const Route = createFileRoute('/app/$organizationId/apps/')({
  validateSearch: appResultSearch,
  staticData: { help: 'apps-and-connections' },
  component: ConnectionsPage,
});
