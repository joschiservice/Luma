import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { CustomersPage } from '../features/customers/page';

export const Route = createFileRoute('/app/$organizationId/customers')({
  validateSearch: z.object({
    appId: z.string().optional().catch(undefined),
    connectionId: z.string().uuid().optional().catch(undefined),
    customerId: z.string().max(512).optional().catch(undefined),
  }),
  staticData: { help: 'customers' },
  component: CustomersPage,
});
