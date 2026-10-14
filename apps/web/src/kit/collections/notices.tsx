import './collections.css';

import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';

import type { CollectionError } from './paging';

/**
 * The offline, access, paging and failure notices every list shows above its rows. A failed
 * refresh keeps the last rows visible, so the notice says they may be outdated.
 */
export function CollectionNotices({
  offline,
  error,
  hasRows,
  retry,
  firstPage,
  repair,
}: {
  offline: boolean;
  error: CollectionError | undefined;
  /** Rows from an earlier read are still shown. */
  hasRows: boolean;
  retry: () => void;
  firstPage: () => void;
  /** Removes the view's conditions the list can't use; offered when the view needs repair. */
  repair?: (() => void) | undefined;
}) {
  return (
    <>
      {offline ? <Alert role="status">{m.collections_offline()}</Alert> : null}
      {error?.kind === 'access' ? (
        <Alert tone="danger" role="alert">
          {m.collections_access_lost()}
        </Alert>
      ) : error?.kind === 'page' ? (
        <Alert role="alert">
          {error.message ?? m.collections_page_mismatch()}{' '}
          <Button variant="outline" onClick={firstPage}>
            {m.collections_first_page()}
          </Button>
        </Alert>
      ) : error?.kind === 'invalid' ? (
        <Alert tone="danger" role="alert">
          {error.message ?? m.collections_invalid_view()}
          {repair ? (
            <>
              {' '}
              <Button variant="outline" onClick={repair}>
                {m.collections_remove_unsupported()}
              </Button>
            </>
          ) : null}
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {hasRows
            ? m.collections_refresh_failed()
            : m.collections_load_failed()}{' '}
          <Button variant="outline" onClick={retry}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
    </>
  );
}

/** Placeholder rows while a list loads for the first time. */
export function CollectionLoading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="collection-loading" role="status">
      <span className="sr-only">{m.collections_loading()}</span>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="lu-skeleton" />
      ))}
    </div>
  );
}
