import { createFileRoute } from '@tanstack/react-router';

import { productsSearch } from '../features/products/data';
import { ProductPage } from '../features/products/detail';

export const Route = createFileRoute('/app/$organizationId/products/$skuId')({
  validateSearch: productsSearch,
  staticData: { help: 'products' },
  component: ProductPage,
});
