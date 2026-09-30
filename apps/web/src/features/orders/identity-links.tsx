import type { IdentityDetail } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useDeferredValue, useState } from 'react';

import { identityOptions } from '../sync/data';
import { IdentityLinks, type IdentitySuggestion } from '../sync/identity-links';
import { ordersOptions } from './data';

/** Links order sources and refreshes orders, Home and Insights after the worker completes. */
export function OrderIdentityLinks({
  organizationId,
  orderId,
}: {
  organizationId: string;
  orderId: string;
}) {
  const client = useQueryClient();
  const changed = useCallback(() => {
    void client.invalidateQueries({
      queryKey: ['private', 'organization', organizationId],
    });
  }, [client, organizationId]);

  return (
    <IdentityLinks
      organizationId={organizationId}
      entityId={orderId}
      kind="order"
      onChanged={changed}
      lookup={(detail, choose) => (
        <OrderLinkSearch
          organizationId={organizationId}
          detail={detail}
          choose={choose}
        />
      )}
    />
  );
}

/** Searches explicitly chosen orders when the source has no marketplace reference. */
function OrderLinkSearch({
  organizationId,
  detail,
  choose,
}: {
  organizationId: string;
  detail: IdentityDetail;
  choose: (suggestion: IdentitySuggestion) => void;
}) {
  const [text, setText] = useState('');
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const client = useQueryClient();

  async function review(id: string) {
    setReviewing(id);
    setReviewError(null);
    try {
      const candidate = await client.fetchQuery(
        identityOptions(organizationId, 'order', id),
      );
      choose({
        id,
        label: candidate.entity.label,
        reason: '',
        sources: candidate.sources,
      });
    } catch {
      setReviewError('This order could not be loaded. Try reviewing it again.');
    } finally {
      setReviewing(null);
    }
  }

  const search = useDeferredValue(text.trim());
  const query = useQuery({
    ...ordersOptions(organizationId, { q: search }),
    enabled: search.length >= 2,
  });
  const candidates = (query.data?.items ?? []).filter(
    (item) =>
      item.id !== detail.entity.id &&
      !item.sources.some((source) =>
        detail.sources.some((own) => own.connectionId === source.connectionId),
      ),
  );
  const busy = detail.requests.some(
    (request) => request.state === 'requested' || request.state === 'running',
  );

  return (
    <div className="sync-order-search">
      <label>
        <span>Find another order</span>
        <Input
          value={text}
          maxLength={120}
          placeholder="Search by order number"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      {reviewError ? (
        <Alert tone="danger" role="alert">
          {reviewError}
        </Alert>
      ) : null}
      {search.length < 2 ? (
        <p className="sync-identity-note">
          Use the order number to find a source record without a suggestion.
        </p>
      ) : query.isPending || search !== text.trim() ? (
        <p role="status">Searching orders…</p>
      ) : query.error ? (
        <Alert tone="danger" role="alert">
          Orders could not be searched.{' '}
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </Alert>
      ) : !candidates.length ? (
        <p role="status" className="sync-identity-note">
          No orders from another connection match this search.
        </p>
      ) : (
        <ul className="sync-identity-sources">
          {candidates.slice(0, 10).map((item) => (
            <li key={item.id}>
              <span className="sync-identity-source">
                <Link
                  to="/app/$organizationId/orders/$orderId"
                  params={{ organizationId, orderId: item.id }}
                >
                  {item.displayNumber ?? 'Order'}
                </Link>
                <small>
                  {item.sources.map((source) => source.label).join(', ')} ·{' '}
                  {item.total
                    ? `${item.total.amount} ${item.total.currency}`
                    : 'Total unknown'}
                </small>
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || reviewing !== null}
                onClick={() => void review(item.id)}
              >
                {reviewing === item.id ? 'Loading…' : 'Review link'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
