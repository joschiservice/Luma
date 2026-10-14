import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { transferSearch } from '../features/inventory/data';
import { TransferPage } from '../features/inventory/transfers';

export const Route = createFileRoute(
  '/app/$organizationId/inventory/transfers/$transferId',
)({
  // The record's source, with the list's view and page for the way back.
  validateSearch: transferSearch.extend({ connectionId: z.uuid() }),
  staticData: { help: 'inventory' },
  component: TransferPage,
});
