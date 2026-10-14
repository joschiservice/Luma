import { transfersCatalog } from '@luma/api-contract';
import { createFileRoute, redirect } from '@tanstack/react-router';

import {
  hasLegacyTransferFilters,
  namesTransferState,
  transferSearch,
  withoutLegacyTransferFilters,
} from '../features/inventory/data';
import { TransfersPage } from '../features/inventory/transfers';
import { rememberedSearch } from '../kit/collections/restore';

export const Route = createFileRoute(
  '/app/$organizationId/inventory/transfers/',
)({
  validateSearch: transferSearch,
  staticData: { help: 'inventory' },
  beforeLoad: async ({ context, params, search }) => {
    // Source and record-kind links from before views become a condition and a built-in view.
    if (hasLegacyTransferFilters(search))
      throw redirect({
        to: '/app/$organizationId/inventory/transfers',
        params,
        search: withoutLegacyTransferFilters(search),
        replace: true,
      });
    // Opened without a view, search, page or context, Transfers returns to the member's last view.
    if (namesTransferState(search)) return;
    const remembered = await rememberedSearch({
      queryClient: context.queryClient,
      organizationId: params.organizationId,
      catalog: transfersCatalog,
      search,
    });
    if (remembered)
      throw redirect({
        to: '/app/$organizationId/inventory/transfers',
        params,
        search: remembered,
        replace: true,
      });
  },
  component: TransfersPage,
});
