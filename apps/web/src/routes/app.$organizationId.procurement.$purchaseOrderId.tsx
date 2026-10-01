import { createFileRoute } from '@tanstack/react-router';

import { PurchaseOrderPage } from '../features/procurement/detail';

export const Route = createFileRoute(
  '/app/$organizationId/procurement/$purchaseOrderId',
)({ staticData: { help: 'procurement' }, component: PurchaseOrderPage });
