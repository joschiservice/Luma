import { createFileRoute } from '@tanstack/react-router';

import { ordersSearch } from '../features/orders/data';
import { OrdersPage } from '../features/orders/page';

export const Route = createFileRoute('/app/$organizationId/orders/')({
  validateSearch: ordersSearch,
  staticData: { help: 'orders' },
  component: OrdersPage,
});
