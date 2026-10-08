import { createFileRoute } from '@tanstack/react-router';

import { inventorySearch } from '../features/inventory/data';
import { InventoryPage } from '../features/inventory/page';

export const Route = createFileRoute('/app/$organizationId/inventory/')({
  validateSearch: inventorySearch,
  staticData: { help: 'inventory' },
  component: InventoryPage,
});
