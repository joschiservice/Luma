import { inventoryCatalog } from '@luma/api-contract';
import { createFileRoute, redirect } from '@tanstack/react-router';

import {
  hasLegacyFilters,
  inventorySearch,
  namesListState,
  withoutLegacyFilters,
} from '../features/inventory/data';
import { InventoryPage } from '../features/inventory/page';
import { rememberedSearch } from '../kit/collections/restore';

export const Route = createFileRoute('/app/$organizationId/inventory/')({
  validateSearch: inventorySearch,
  staticData: { help: 'inventory' },
  beforeLoad: async ({ context, params, search }) => {
    // Location and source links from before views become the same conditions.
    if (hasLegacyFilters(search))
      throw redirect({
        to: '/app/$organizationId/inventory',
        params,
        search: withoutLegacyFilters(search),
        replace: true,
      });
    // Opened without a view, search, page or context, Inventory returns to the member's last view.
    if (namesListState(search)) return;
    const remembered = await rememberedSearch({
      queryClient: context.queryClient,
      organizationId: params.organizationId,
      catalog: inventoryCatalog,
      search,
    });
    if (remembered)
      throw redirect({
        to: '/app/$organizationId/inventory',
        params,
        search: remembered,
        replace: true,
      });
  },
  component: InventoryPage,
});
