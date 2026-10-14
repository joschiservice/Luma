import { ordersCatalog } from '@luma/api-contract';
import { createFileRoute, redirect } from '@tanstack/react-router';

import {
  hasLegacyFilters,
  namesListState,
  ordersSearch,
  withoutLegacyFilters,
} from '../features/orders/data';
import { OrdersPage } from '../features/orders/page';
import { rememberedSearch } from '../kit/collections/restore';

export const Route = createFileRoute('/app/$organizationId/orders/')({
  validateSearch: ordersSearch,
  staticData: { help: 'orders' },
  beforeLoad: async ({ context, params, search }) => {
    // Links from before views, such as Insights drill-downs, become the same conditions.
    if (hasLegacyFilters(search))
      throw redirect({
        to: '/app/$organizationId/orders',
        params,
        search: withoutLegacyFilters(search),
        replace: true,
      });
    // Opened without a view, search, page or context, Orders returns to the member's last view.
    if (namesListState(search)) return;
    const remembered = await rememberedSearch({
      queryClient: context.queryClient,
      organizationId: params.organizationId,
      catalog: ordersCatalog,
      search,
    });
    if (remembered)
      throw redirect({
        to: '/app/$organizationId/orders',
        params,
        search: remembered,
        replace: true,
      });
  },
  component: OrdersPage,
});
