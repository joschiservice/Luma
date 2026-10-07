import { createFileRoute } from '@tanstack/react-router';

import { customersSearch } from '../features/customers/data';
import { CustomersPage } from '../features/customers/page';

export const Route = createFileRoute('/app/$organizationId/customers/')({
  validateSearch: customersSearch,
  staticData: { help: 'customers' },
  component: CustomersPage,
});
