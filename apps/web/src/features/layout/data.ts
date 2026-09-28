import {
  type HomeModule,
  type PinnedPage,
  type WorkspaceLayout,
  workspaceLayoutSchema,
} from '@luma/api-contract';
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';

import { privateQueryDefaults } from '../../lib/private-query';
import { settingsApi, SettingsError } from '../settings/data';

/** Returns the query key for one member's layout in a workspace. */
export const layoutKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'layout'] as const;

/** Loads the signed-in member's Home modules and sidebar pins for a workspace. */
export const layoutOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    gcTime: 5 * 60_000,
    queryKey: layoutKey(organizationId),
    queryFn: async ({ signal }) => {
      const result = await settingsApi.settings.layout({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200)
        throw new SettingsError(result.status, result.body.message);

      return workspaceLayoutSchema.parse(result.body);
    },
  });

type LayoutChange = { home?: HomeModule[] | null; pinned?: PinnedPage[] };

function apply(base: WorkspaceLayout, change: LayoutChange): WorkspaceLayout {
  return {
    ...base,
    home: change.home === undefined ? base.home : change.home,
    pinned: change.pinned ?? base.pinned,
  };
}

/**
 * Reads and saves a member's personal layout. Changes apply immediately and are saved
 * against the last revision read. If another session saved first, the latest layout is
 * reloaded and `conflict` becomes true so the page can explain what happened.
 */
export function useWorkspaceLayout(organizationId: string) {
  const client = useQueryClient();
  const key = layoutKey(organizationId);
  const query = useQuery(layoutOptions(organizationId));
  const queued = useRef<LayoutChange | null>(null);
  const inFlight = useRef(false);
  const mutation = useMutation({
    mutationFn: async ({
      base,
      change,
    }: {
      base: WorkspaceLayout;
      change: LayoutChange;
    }) => {
      const next = apply(base, change);
      const result = await settingsApi.settings.saveLayout({
        params: { organizationId },
        body: {
          revision: base.revision,
          home: next.home,
          pinned: next.pinned,
        },
      });
      if (result.status !== 200)
        throw new SettingsError(result.status, result.body.message);

      return workspaceLayoutSchema.parse(result.body);
    },
    onSuccess: (saved) => {
      client.setQueryData(
        key,
        queued.current ? apply(saved, queued.current) : saved,
      );
    },
    onError: () => {
      queued.current = null;
      void client.invalidateQueries({ queryKey: key });
    },
    onSettled: (saved) => {
      const change = queued.current;
      queued.current = null;
      if (change && saved) mutation.mutate({ base: saved, change });
      else inFlight.current = false;
    },
  });

  function save(change: LayoutChange) {
    const current = client.getQueryData<WorkspaceLayout>(key) ?? query.data;
    if (!current) return;
    client.setQueryData(key, apply(current, change));
    // Saves run one at a time so each uses the revision returned by the last.
    if (inFlight.current) {
      queued.current = { ...queued.current, ...change };

      return;
    }
    inFlight.current = true;
    mutation.mutate({ base: current, change });
  }

  return {
    layout: query.data,
    loading: query.isPending,
    error: query.isError,
    saving: mutation.isPending,
    conflict:
      mutation.error instanceof SettingsError && mutation.error.status === 409,
    saveFailed: mutation.isError,
    save,
  };
}
