import {
  type AdaptiveView,
  type AdaptiveViewQueryV1,
  type AdaptiveViewQueryV2,
  type CollectionDomain,
  type CollectionMemberState,
  type CollectionMemberStateResponse,
  upgradeAdaptiveViewQuery,
} from '@luma/api-contract';
import { type QueryClient, queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

/** Scopes list settings caches to the trusted workspace and list. */
const collectionKey = (organizationId: string, domain: CollectionDomain) =>
  ['private', 'organization', organizationId, 'collections', domain] as const;

/** Reads what the member last had open on a list page. */
export const collectionStateOptions = (
  organizationId: string,
  domain: CollectionDomain,
) =>
  queryOptions({
    ...privateQueryDefaults,
    // Kept for the session so returning to the list does not wait on it again.
    gcTime: 5 * 60_000,
    queryKey: [...collectionKey(organizationId, domain), 'state'],
    queryFn: ({ signal }) =>
      api.collections.state({ params: { organizationId, domain } }, { signal }),
  });

/** A saved view of one list, with its query upgraded to the current format. */
export interface CollectionSavedView {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  revision: number;
  canEdit: boolean;
  sharing: AdaptiveView['sharing'];
  query: AdaptiveViewQueryV2;
}

function savedView(view: AdaptiveView): CollectionSavedView {
  // Saved views may still be stored in format 1; the upgrade keeps their meaning.
  const query: AdaptiveViewQueryV1 | AdaptiveViewQueryV2 = view.query;

  return {
    id: view.id,
    name: view.name,
    description: view.description,
    ownerId: view.ownerId,
    revision: view.revision,
    canEdit: view.canEdit,
    sharing: view.sharing,
    query: upgradeAdaptiveViewQuery(query),
  };
}

/**
 * Lists the saved views of one list that the member may open. When saved views are turned off
 * for the workspace, the list is empty and only built-in views are offered.
 */
export const collectionViewsOptions = (
  organizationId: string,
  domain: CollectionDomain,
) =>
  queryOptions({
    ...privateQueryDefaults,
    gcTime: 5 * 60_000,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'adaptive',
      'views',
      'collection',
      domain,
    ],
    queryFn: async ({ signal }) => {
      try {
        const views = await api.adaptiveViews.list(
          { params: { organizationId } },
          { signal },
        );

        return {
          available: true,
          items: views.items
            .filter((view) => view.query.domain === domain && !view.archived)
            .map(savedView),
        };
      } catch (error) {
        if (error instanceof IdentityError && error.status === 404)
          return { available: false, items: [] as CollectionSavedView[] };
        throw error;
      }
    },
  });

/**
 * Saves the member's list state. The sequence orders saves from this browser; the server
 * ignores a save older than the stored one, so a late request never replaces a newer state.
 */
export function saveCollectionState(
  organizationId: string,
  domain: CollectionDomain,
  state: CollectionMemberState,
  sequence: number,
): Promise<CollectionMemberStateResponse> {
  return api.collections.saveState({
    params: { organizationId, domain },
    body: { state, sequence },
  });
}

/** Removes the member's state and personal display settings for one list. */
export function resetCollectionState(
  organizationId: string,
  domain: CollectionDomain,
): Promise<CollectionMemberStateResponse> {
  return api.collections.resetState({ params: { organizationId, domain } });
}

/** Removes the member's state and personal display settings for every list. */
export function resetAllCollectionStates(organizationId: string) {
  return api.collections.resetAll({ params: { organizationId } });
}

/** Creates a saved view from the list's current state. */
export function createCollectionView(
  organizationId: string,
  input: {
    name: string;
    description?: string;
    sharing: AdaptiveView['sharing'];
    query: AdaptiveViewQueryV2;
  },
) {
  return api.adaptiveViews.create({
    params: { organizationId },
    body: {
      commandId: crypto.randomUUID(),
      name: input.name,
      description: input.description ?? '',
      sharing: input.sharing,
      query: input.query,
      reviewed: true,
    },
  });
}

/** Saves a new revision of a view; a stale revision is refused with 409. */
export function updateCollectionView(
  organizationId: string,
  view: CollectionSavedView,
  change: Partial<
    Pick<CollectionSavedView, 'name' | 'description' | 'sharing' | 'query'>
  >,
) {
  return api.adaptiveViews.update({
    params: { organizationId, viewId: view.id },
    body: {
      commandId: crypto.randomUUID(),
      name: change.name ?? view.name,
      description: change.description ?? view.description,
      sharing: change.sharing ?? view.sharing,
      query: change.query ?? view.query,
      reviewed: true,
      expectedRevision: view.revision,
    },
  });
}

/** Archives a view, keeping its history. */
export function archiveCollectionView(
  organizationId: string,
  view: CollectionSavedView,
) {
  return api.adaptiveViews.archive({
    params: { organizationId, viewId: view.id },
    body: { expectedRevision: view.revision },
  });
}

/** Exports the visible columns of a list query as CSV; the API caps and audits each export. */
export function exportCollection(
  organizationId: string,
  input: { query: AdaptiveViewQueryV2; labels: Record<string, string> },
) {
  return api.collections.export({
    params: { organizationId, domain: input.query.domain },
    body: input,
  });
}

/** Refreshes saved views and remembered state after a change. */
export function invalidateCollection(
  queryClient: QueryClient,
  organizationId: string,
) {
  return queryClient.invalidateQueries({
    queryKey: ['private', 'organization', organizationId, 'adaptive', 'views'],
  });
}
