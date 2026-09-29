import { createFileRoute } from '@tanstack/react-router';

import { ordersSearch } from '../features/orders/data';
import { OrderPage } from '../features/orders/detail';

export const Route = createFileRoute('/app/$organizationId/orders/$orderId')({
  validateSearch: ordersSearch,
  staticData: { help: 'orders' },
  component: OrderPage,
});
