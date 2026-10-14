import type { CollectionCatalog } from '@luma/api-contract';
import type { QueryClient } from '@tanstack/react-query';

import { collectionStateOptions, collectionViewsOptions } from './data';
import {
  builtinState,
  type CollectionSearch,
  hasViewInUrl,
  viewParam,
  viewRef,
  viewSearch,
} from './state';

/**
 * Finds the view to open when a list is opened without one, such as from the sidebar: the
 * member's remembered view and unsaved changes, else their default view. Returns null when the
 * URL already names a view, nothing is remembered or the read fails, so the page opens its
 * default without waiting. A remembered saved view that is no longer available is skipped.
 */
export async function rememberedSearch({
  queryClient,
  organizationId,
  catalog,
  search,
}: {
  queryClient: QueryClient;
  organizationId: string;
  catalog: CollectionCatalog;
  search: Record<string, unknown>;
}): Promise<Partial<CollectionSearch> | null> {
  if (hasViewInUrl(search)) return null;
  try {
    const member = await queryClient.ensureQueryData(
      collectionStateOptions(organizationId, catalog.domain),
    );
    const state = member.state;
    const key = state?.view ?? state?.defaultView;
    if (!state || !key) return null;
    const ref = viewRef(catalog, viewParam(key));
    let base = builtinState(
      catalog,
      ref.kind === 'builtin' ? ref.segment : 'all',
    );
    if (ref.kind === 'saved') {
      const views = await queryClient.ensureQueryData(
        collectionViewsOptions(organizationId, catalog.domain),
      );
      const saved = views.items.find((view) => view.id === ref.id);
      if (!saved) return null;
      base = saved.query.state;
    }

    return viewSearch(ref, base, state.view === key ? state.draft : null);
  } catch {
    return null;
  }
}
