import { issuesCatalog } from '@luma/api-contract';
import { createFileRoute, redirect } from '@tanstack/react-router';

import {
  hasLegacyFilters,
  inboxSearch,
  namesListState,
  withoutLegacyFilters,
} from '../features/exceptions/data';
import { Inbox } from '../features/exceptions/page';
import { rememberedSearch } from '../kit/collections/restore';

export const Route = createFileRoute('/app/$organizationId/exceptions')({
  validateSearch: inboxSearch,
  staticData: { help: 'issues' },
  beforeLoad: async ({ context, params, search, location }) => {
    const list = /\/exceptions\/?$/.test(location.pathname);
    // The open issue's ID is not among this layout route's own parameters.
    const exceptionId = /\/exceptions\/([^/]+)\/?$/.exec(
      location.pathname,
    )?.[1];
    // Links from before views, such as Insights' issue types, become the same conditions.
    if (hasLegacyFilters(search))
      throw exceptionId
        ? redirect({
            to: '/app/$organizationId/exceptions/$exceptionId',
            params: { ...params, exceptionId: decodeURIComponent(exceptionId) },
            search: withoutLegacyFilters(search),
            replace: true,
          })
        : redirect({
            to: '/app/$organizationId/exceptions',
            params,
            search: withoutLegacyFilters(search),
            replace: true,
          });
    // Opened without a view, search, page or issue, the list returns to the member's last view.
    if (!list || namesListState(search)) return;
    const remembered = await rememberedSearch({
      queryClient: context.queryClient,
      organizationId: params.organizationId,
      catalog: issuesCatalog,
      search,
    });
    if (remembered)
      throw redirect({
        to: '/app/$organizationId/exceptions',
        params,
        search: remembered,
        replace: true,
      });
  },
  component: Inbox,
});
