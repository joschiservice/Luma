import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { TransferPage } from '../features/inventory/transfers';

export const Route = createFileRoute(
  '/app/$organizationId/inventory/transfers/$transferId',
)({
  validateSearch: z.object({ connectionId: z.string().uuid() }),
  staticData: { help: 'inventory' },
  component: TransferPage,
});
