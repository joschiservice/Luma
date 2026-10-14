import { procurementCatalog, suppliersCatalog } from '@luma/api-contract';
import { createFileRoute, redirect } from '@tanstack/react-router';

import {
  hasLegacyProcurementKeys,
  namesListState,
  procurementSearch,
  procurementTab,
  withoutLegacyProcurementKeys,
} from '../features/procurement/data';
import { ProcurementPage } from '../features/procurement/page';
import { rememberedSearch } from '../kit/collections/restore';

export const Route = createFileRoute('/app/$organizationId/procurement/')({
  validateSearch: procurementSearch,
  staticData: { help: 'procurement' },
  beforeLoad: async ({ context, params, search }) => {
    // Links from before views, such as `view=suppliers` or `stage=attention`, keep working.
    if (hasLegacyProcurementKeys(search))
      throw redirect({
        to: '/app/$organizationId/procurement',
        params,
        search: withoutLegacyProcurementKeys(search),
        replace: true,
      });
    // Opened without a view, search, page or open order, each list returns to the member's
    // last view of it.
    if (namesListState(search)) return;
    const tab = procurementTab(search);
    const remembered = await rememberedSearch({
      queryClient: context.queryClient,
      organizationId: params.organizationId,
      catalog: tab === 'suppliers' ? suppliersCatalog : procurementCatalog,
      search,
    });
    if (remembered)
      throw redirect({
        to: '/app/$organizationId/procurement',
        params,
        search: { ...(search.tab ? { tab: search.tab } : {}), ...remembered },
        replace: true,
      });
  },
  component: ProcurementPage,
});
