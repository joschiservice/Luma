import { createFileRoute } from '@tanstack/react-router';

import { SyncPage } from '../features/sync/page';

export const Route = createFileRoute('/app/$organizationId/sync')({
  staticData: { help: 'data-sync' },
  component: SyncPage,
});
