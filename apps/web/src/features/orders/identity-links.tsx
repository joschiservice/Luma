import type { IdentityDetail } from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useDeferredValue, useState } from 'react';

import { identityOptions } from '../sync/data';
import { IdentityLinks, type IdentitySuggestion } from '../sync/identity-links';
import { ordersOptions } from './data';
import { formatMoney, orderLabel } from './presentation';

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
      setReviewError(m.orders_link_review_failed());
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
        <span>{m.orders_link_search_label()}</span>
        <Input
          value={text}
          maxLength={120}
          placeholder={m.orders_link_search_placeholder()}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      {reviewError ? (
        <Alert tone="danger" role="alert">
          {reviewError}
        </Alert>
      ) : null}
      {search.length < 2 ? (
        <p className="sync-identity-note">{m.orders_link_search_hint()}</p>
      ) : query.isPending || search !== text.trim() ? (
        <p role="status">{m.orders_link_searching()}</p>
      ) : query.error ? (
        <Alert tone="danger" role="alert">
          {m.orders_link_search_failed()}{' '}
          <Button variant="outline" onClick={() => void query.refetch()}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : !candidates.length ? (
        <p role="status" className="sync-identity-note">
          {m.orders_link_search_empty()}
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
                  {orderLabel(item)}
                </Link>
                <small>
                  {formatList(item.sources.map((source) => source.label))} ·{' '}
                  {formatMoney(item.total) ?? m.orders_link_total_unknown()}
                </small>
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || reviewing !== null}
                onClick={() => void review(item.id)}
              >
                {reviewing === item.id
                  ? m.common_loading()
                  : m.orders_link_review()}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
