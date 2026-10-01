import { createFileRoute } from '@tanstack/react-router';

import { SupplierPage } from '../features/procurement/supplier';

export const Route = createFileRoute(
  '/app/$organizationId/procurement/suppliers/$supplierId',
)({ staticData: { help: 'procurement' }, component: SupplierPage });
