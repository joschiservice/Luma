import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { ConnectionsPage } from '../features/connections/page';

export const Route = createFileRoute('/app/$organizationId/connections')({
  validateSearch: z.object({
    shopify: z
      .enum(['connected', 'denied', 'permissions', 'failed'])
      .optional()
      .catch(undefined),
  }),
  component: ConnectionsPage,
});
