import { createFileRoute } from '@tanstack/react-router';

import { CustomerPage } from '../features/customers/detail';

export const Route = createFileRoute(
  '/app/$organizationId/customers/$customerId',
)({
  staticData: { help: 'customers' },
  component: CustomerPage,
});
