import { createFileRoute } from '@tanstack/react-router';

import { productsSearch } from '../features/products/data';
import { ProductsPage } from '../features/products/page';

export const Route = createFileRoute('/app/$organizationId/products/')({
  validateSearch: productsSearch,
  staticData: { help: 'products' },
  component: ProductsPage,
});
