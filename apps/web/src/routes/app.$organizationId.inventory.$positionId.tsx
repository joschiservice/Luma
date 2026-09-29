import { createFileRoute } from '@tanstack/react-router';

import { inventorySearch } from '../features/inventory/data';
import { StockPage } from '../features/inventory/detail';

export const Route = createFileRoute(
  '/app/$organizationId/inventory/$positionId',
)({ validateSearch: inventorySearch, component: StockPage });
