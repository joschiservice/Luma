import { createFileRoute } from '@tanstack/react-router';

import { transferSearch } from '../features/inventory/data';
import { TransfersPage } from '../features/inventory/transfers';

export const Route = createFileRoute(
  '/app/$organizationId/inventory/transfers/',
)({
  validateSearch: transferSearch,
  staticData: { help: 'inventory' },
  component: TransfersPage,
});
