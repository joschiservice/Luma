import type {
  CollectionCatalog,
  CollectionDomain,
  CollectionMemberState,
  CollectionPersonalDisplay,
  CollectionViewState,
} from '@luma/api-contract';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type CollectionSavedView,
  collectionStateOptions,
  collectionViewsOptions,
  resetCollectionState,
  saveCollectionState,
} from './data';
import {
  builtinState,
  type CollectionSearch,
  type CollectionViewRef,
  effectiveState,
  isModified,
  stateChanges,
  viewKey,
  viewParam,
  viewRef,
} from './state';

/** A view offered in a list's view menu. */
type CollectionMenuView =
  | { kind: 'builtin'; key: string; segment: string }
  | { kind: 'saved'; key: string; view: CollectionSavedView };

export interface CollectionView {
  domain: CollectionDomain;
  ref: CollectionViewRef;
  key: string;
  /** The open saved view, when the URL names one the member may open. */
  saved: CollectionSavedView | undefined;
  /** The URL names a saved view that is missing, archived or no longer shared with the member. */
  unavailable: boolean;
  /** The view's own definition. */
  base: CollectionViewState;
  /** What the page shows: the view with the URL's changes and personal display settings. */
  state: CollectionViewState;
  /** The member's display settings for this view, which never mark it Modified. */
  display: CollectionPersonalDisplay;
  modified: boolean;
  views: CollectionMenuView[];
  savedViewsAvailable: boolean;
  defaultView: string | null;
  /** Shows a changed state, keeping only differences from the view in the URL. */
  change(next: CollectionViewState): void;
  /** Opens another view without changes. */
  open(key: string): void;
  /** Discards unsaved changes. */
  reset(): void;
  setDisplay(display: CollectionPersonalDisplay): void;
  setDefaultView(key: string | null): void;
  /** Stores the member's own order of the view menu, as view keys. */
  setOrder(keys: readonly string[]): void;
  /** Clears remembered state and personal display settings for this list, then opens its default. */
  resetPage(): Promise<CollectionMemberState | null>;
  /** Restores member state removed by `resetPage`. */
  restore(state: CollectionMemberState): Promise<void>;
}

const emptyDisplay: CollectionPersonalDisplay = {
  widths: {},
  collapsedGroups: [],
};

const remembered = (
  state: CollectionMemberState | null | undefined,
): CollectionMemberState => ({
  view: state?.view ?? null,
  baseRevision: state?.baseRevision ?? null,
  draft: state?.draft ?? null,
  defaultView: state?.defaultView ?? null,
  order: state?.order ?? [],
  display: state?.display ?? {},
});

/**
 * Resolves a list's view from the URL, saved views and the member's remembered state, and keeps
 * that state in sync across devices. State is remembered only after the member changes
 * something on the page, never merely because a link was opened. Saves wait about a second and
 * are sent immediately when the tab is hidden; failures are retried with the newest state only.
 */
export function useCollectionView({
  catalog,
  organizationId,
  search,
  navigate,
  readOnly = false,
}: {
  catalog: CollectionCatalog;
  organizationId: string;
  search: CollectionSearch;
  /** Replaces the list's URL state; paging and search text are reset by the caller. */
  navigate: (search: Partial<CollectionSearch>) => void;
  /** Read-only support views never write member state. */
  readOnly?: boolean;
}): CollectionView {
  const domain = catalog.domain;
  const queryClient = useQueryClient();
  const views = useQuery(collectionViewsOptions(organizationId, domain));
  const member = useQuery(collectionStateOptions(organizationId, domain));
  const ref = viewRef(catalog, search.view);
  const key = viewKey(ref);
  const saved =
    ref.kind === 'saved'
      ? views.data?.items.find((item) => item.id === ref.id)
      : undefined;
  const unavailable = ref.kind === 'saved' && !!views.data && !saved;
  const base = useMemo(
    () =>
      saved?.query.state ??
      builtinState(
        catalog,
        ref.kind === 'builtin' ? ref.segment : (catalog.segments[0] ?? 'all'),
      ),
    [catalog, ref, saved],
  );
  const stored = remembered(member.data?.state);
  const [local, setLocal] = useState<CollectionMemberState | null>(null);
  const current = local ?? stored;
  const display = current.display[key] ?? emptyDisplay;
  const state = useMemo(() => {
    const next = effectiveState(base, search);

    return { ...next, density: display.density ?? next.density };
  }, [base, display.density, search]);
  const modified = isModified(base, search);

  const sequence = useRef(0);
  const pending = useRef<CollectionMemberState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    if (!next || readOnly) return;
    pending.current = null;
    sequence.current = Math.max(Date.now(), sequence.current + 1);
    saveCollectionState(organizationId, domain, next, sequence.current).then(
      (response) =>
        queryClient.setQueryData(
          collectionStateOptions(organizationId, domain).queryKey,
          response,
        ),
      () => {
        // Keep working; the newest state is sent with the next change or when the tab hides.
        pending.current ??= next;
      },
    );
  }, [domain, organizationId, queryClient, readOnly]);
  const remember = useCallback(
    (next: CollectionMemberState) => {
      setLocal(next);
      pending.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, 1000);
    },
    [flush],
  );
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', hidden);

    return () => {
      document.removeEventListener('visibilitychange', hidden);
      flush();
    };
  }, [flush]);

  const go = useCallback(
    (target: CollectionViewRef, draft: CollectionViewState | null) => {
      const targetBase =
        target.kind === 'saved'
          ? (views.data?.items.find((item) => item.id === target.id)?.query
              .state ?? base)
          : builtinState(catalog, target.segment);
      navigate({
        view: target.kind === 'saved' ? target.id : target.segment,
        ...(draft ? stateChanges(targetBase, draft) : {}),
      });
      remember({
        ...current,
        view: viewKey(target),
        baseRevision:
          target.kind === 'saved'
            ? (views.data?.items.find((item) => item.id === target.id)
                ?.revision ?? null)
            : null,
        draft:
          draft && Object.keys(stateChanges(targetBase, draft)).length
            ? draft
            : null,
      });
    },
    [base, catalog, current, navigate, remember, views.data],
  );

  const menu: CollectionMenuView[] = useMemo(() => {
    const builtins: CollectionMenuView[] = catalog.segments.map((segment) => ({
      kind: 'builtin',
      key: `builtin:${segment}`,
      segment,
    }));
    const savedViews: CollectionMenuView[] = (views.data?.items ?? []).map(
      (view) => ({ kind: 'saved', key: view.id, view }),
    );
    const order = new Map(current.order.map((item, index) => [item, index]));

    return [...builtins, ...savedViews].sort(
      (left, right) =>
        (order.get(left.key) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.key) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [catalog.segments, current.order, views.data?.items]);

  return {
    domain,
    ref,
    key,
    saved,
    unavailable,
    base,
    state,
    display,
    modified,
    views: menu,
    savedViewsAvailable: views.data?.available ?? false,
    defaultView: current.defaultView,
    change: (next) => go(ref, next),
    open: (target) => go(viewRef(catalog, viewParam(target)), null),
    reset: () => go(ref, null),
    setDisplay: (next) =>
      remember({ ...current, display: { ...current.display, [key]: next } }),
    setDefaultView: (next) => remember({ ...current, defaultView: next }),
    setOrder: (keys) => remember({ ...current, order: [...keys] }),
    async resetPage() {
      const previous = member.data?.state ?? null;
      pending.current = null;
      setLocal(null);
      if (!readOnly) {
        const response = await resetCollectionState(organizationId, domain);
        queryClient.setQueryData(
          collectionStateOptions(organizationId, domain).queryKey,
          response,
        );
      }
      const fallback = viewRef(catalog, undefined);
      navigate({
        view: fallback.kind === 'saved' ? fallback.id : fallback.segment,
      });

      return previous;
    },
    async restore(previous) {
      setLocal(previous);
      pending.current = previous;
      flush();
      const target = previous.view
        ? viewRef(catalog, viewParam(previous.view))
        : null;
      if (target) go(target, previous.draft);
    },
  };
}
