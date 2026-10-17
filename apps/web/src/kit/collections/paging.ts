import { onlineManager } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

import { ApiError } from '../identity/data';

const storageKey = (key: string) => `luma:paging:${key}`;

function readTrail(key: string): (string | null)[] {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(storageKey(key)) ?? '[null]',
    );

    return Array.isArray(value) &&
      value.every((item) => item === null || typeof item === 'string')
      ? value
      : [null];
  } catch {
    return [null];
  }
}

function writeTrail(key: string, trail: (string | null)[]) {
  try {
    sessionStorage.setItem(
      storageKey(key),
      JSON.stringify(trail.slice(0, 200)),
    );
  } catch {
    // Paging still works without Previous when storage is unavailable.
  }
}

export interface CursorPaging {
  page: number;
  /** Opens the next page; undefined on the last page. */
  next?: (() => void) | undefined;
  /** Opens the previous page; undefined on the first page or when its cursor is unknown. */
  previous?: (() => void) | undefined;
  /** Returns to the first page; offered when Previous is unavailable after a reload. */
  first?: (() => void) | undefined;
}

/**
 * Keyset paging with the page number and cursor in the URL. The cursors of earlier pages are
 * kept per filter combination in session storage, so Previous survives reloads and returning
 * from a record. `key` must change whenever filters, sorting or the view change.
 */
export function useCursorPaging({
  key,
  cursor,
  page = 1,
  nextCursor,
  go,
}: {
  key: string;
  cursor: string | undefined;
  page: number | undefined;
  nextCursor: string | null | undefined;
  go: (position: {
    cursor: string | undefined;
    page: number | undefined;
  }) => void;
}): CursorPaging {
  const trail = readTrail(key);
  const current = trail[page - 1];
  // A trail recorded for another position no longer describes how we got here.
  const known = (current ?? undefined) === cursor;
  const earlier = page > 1 && known ? trail[page - 2] : undefined;
  const next = useCallback(() => {
    if (!nextCursor) return;
    const recorded = known ? trail.slice(0, page) : [];
    if (!known) {
      for (let index = 0; index < page - 1; index += 1) recorded.push(null);
      recorded.push(cursor ?? null);
    }
    writeTrail(key, [...recorded, nextCursor]);
    go({ cursor: nextCursor, page: page + 1 });
  }, [cursor, go, key, known, nextCursor, page, trail]);

  return {
    page,
    next: nextCursor ? next : undefined,
    previous:
      page > 1 && earlier !== undefined
        ? () =>
            go({ cursor: earlier ?? undefined, page: page - 1 || undefined })
        : undefined,
    first:
      cursor && (page <= 1 || earlier === undefined)
        ? () => go({ cursor: undefined, page: undefined })
        : undefined,
  };
}

/** The reason a list could not be shown or refreshed. */
export type CollectionError =
  | { kind: 'access' }
  | { kind: 'page'; message?: string | undefined }
  | { kind: 'invalid'; message?: string | undefined }
  | { kind: 'unavailable' };

/**
 * Classifies a list failure. 403 and 404 mean the reader lost access. A validation error with a
 * cursor means the page link no longer matches its filters; without one, the view itself asks
 * for something the list cannot do and needs repair.
 */
export function collectionError(
  error: unknown,
  cursor: string | undefined,
): CollectionError | undefined {
  if (!error) return undefined;
  if (!(error instanceof ApiError)) return { kind: 'unavailable' };
  if ([403, 404].includes(error.status)) return { kind: 'access' };
  if (error.code === 'VALIDATION_ERROR' || error.status === 400)
    return cursor
      ? { kind: 'page', message: error.message }
      : { kind: 'invalid', message: error.message };

  return { kind: 'unavailable' };
}

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);

/** Whether the browser is online, following the query client's online manager. */
export function useOnline() {
  return useSyncExternalStore(
    subscribe,
    () => onlineManager.isOnline(),
    () => true,
  );
}

/**
 * The condition a list rejected, from the shared engine's 400 message "Condition 2: …", so the
 * page can mark that chip. Returns an issue without an index for other validation messages.
 */
export function collectionServerIssue(
  error: unknown,
): { index: number | null; message: string } | undefined {
  if (!(error instanceof ApiError) || error.status !== 400) return undefined;
  const match = /^Condition (\d+): (.+?)\.?$/.exec(error.message);

  return match
    ? { index: Number(match[1]) - 1, message: match[2] ?? error.message }
    : { index: null, message: error.message };
}
