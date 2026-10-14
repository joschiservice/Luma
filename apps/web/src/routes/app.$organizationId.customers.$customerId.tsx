import { createFileRoute } from '@tanstack/react-router';

import { customersSearch } from '../features/customers/data';
import { CustomerPage } from '../features/customers/detail';

export const Route = createFileRoute(
  '/app/$organizationId/customers/$customerId',
)({
  validateSearch: customersSearch,
  staticData: { help: 'customers' },
  component: CustomerPage,
});
