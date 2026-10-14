import { productsCatalog } from '@luma/api-contract';
import { createFileRoute, redirect } from '@tanstack/react-router';

import {
  hasLegacyFilters,
  namesListState,
  productsSearch,
  withoutLegacyFilters,
} from '../features/products/data';
import { ProductsPage } from '../features/products/page';
import { rememberedSearch } from '../kit/collections/restore';

export const Route = createFileRoute('/app/$organizationId/products/')({
  validateSearch: productsSearch,
  staticData: { help: 'products' },
  beforeLoad: async ({ context, params, search }) => {
    // "Listed in" and "Missing from" links from before views become the same conditions.
    if (hasLegacyFilters(search))
      throw redirect({
        to: '/app/$organizationId/products',
        params,
        search: withoutLegacyFilters(search),
        replace: true,
      });
    // Opened without a view, search, page or context, Products returns to the member's last view.
    if (namesListState(search)) return;
    const remembered = await rememberedSearch({
      queryClient: context.queryClient,
      organizationId: params.organizationId,
      catalog: productsCatalog,
      search,
    });
    if (remembered)
      throw redirect({
        to: '/app/$organizationId/products',
        params,
        search: remembered,
        replace: true,
      });
  },
  component: ProductsPage,
});
