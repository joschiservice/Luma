import './adaptive.css';

import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';

import type { CollectionView } from '../../kit/collections/use-collection-view';
import { AdaptiveActions } from './actions';

/** Records one bulk run may cover; the governed action API accepts at most this many. */
const bulkActionLimit = 100;

/**
 * Shows the open saved view's governed actions for the selected rows of a list page. Each
 * selected record becomes its own command through policy, approval and idempotency, with its
 * own result. Built-in views have no actions; members can save a view with actions instead.
 */
export function CollectionBulkActions({
  organizationId,
  view,
  selected,
  clear,
}: {
  organizationId: string;
  view: CollectionView;
  selected: readonly string[];
  clear: () => void;
}) {
  if (!selected.length) return null;
  const saved = view.saved;
  const over = selected.length > bulkActionLimit;

  return (
    <div
      className="collection-bulk-actions"
      role="region"
      aria-label={m.collections_bulk_label()}
    >
      <span role="status">
        {m.collections_bulk_selected({ count: selected.length })}
      </span>
      {over ? (
        <Alert role="status">
          {m.collections_bulk_limit({ count: bulkActionLimit })}
        </Alert>
      ) : saved?.query.actions.length ? (
        <AdaptiveActions
          organizationId={organizationId}
          viewId={saved.id}
          recordIds={[...selected]}
        />
      ) : (
        <p className="collection-bulk-note">
          {m.collections_bulk_no_actions()}
        </p>
      )}
      <Button variant="ghost" onClick={clear}>
        {m.collections_bulk_clear()}
      </Button>
    </div>
  );
}
