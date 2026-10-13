import { createFileRoute } from '@tanstack/react-router';

import { PackagesPage } from '../features/adaptive/packages';

export const Route = createFileRoute('/app/$organizationId/views/packages')({
  staticData: { help: 'saved-views' },
  component: PackagesPage,
});
