import { createFileRoute } from '@tanstack/react-router';

import { syncSearch } from '../features/sync/data';
import { SyncPage } from '../features/sync/page';

export const Route = createFileRoute('/app/$organizationId/sync')({
  validateSearch: syncSearch,
  staticData: { help: 'data-sync' },
  component: SyncPage,
});
