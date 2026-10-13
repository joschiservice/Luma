import type { PurchaseOrderRecord } from '@luma/api-contract';
import { formatExactQuantity } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { Input } from '@luma/ui/components/primitives/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { contextOptions } from '../../kit/identity/data';
import { useCan } from '../../kit/identity/permissions';
import { privateQueryDefaults } from '../../lib/private-query';
import { AppExtension } from '../apps/extension';
import { createProcurementClient, procurementError } from './data';

const api = createProcurementClient();

/** Routes manual receipt booking to the reviewed stock owner and preserves independent verification. */
export function ReceiptStockBooking({
  organizationId,
  record,
}: {
  organizationId: string;
  record: PurchaseOrderRecord;
}) {
  const canRead = useCan(organizationId, 'inventory.read');
  const client = useQueryClient();
  const query = useQuery({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'procurement',
      'receipt-stock',
      record.order.id,
    ],
    enabled: canRead,
    queryFn: ({ signal }) =>
      api.nativeStock.purchaseReceiptReviews(
        { params: { organizationId, purchaseOrderId: record.order.id } },
        { signal },
      ),
  });
  const manualLines = record.order.lines.filter((line) =>
    record.commitments.some(
      (fact) =>
        fact.lineId === line.id &&
        fact.kind === 'received' &&
        fact.status === 'confirmed' &&
        fact.source.kind === 'manual_receipt',
    ),
  );
  if (!canRead || !manualLines.length || query.data?.enabled === false)
    return null;
  const changed = async () => {
    await client.invalidateQueries({
      queryKey: ['private', 'organization', organizationId],
    });
  };

  return (
    <section>
      {query.isPending ? <p role="status">{m.common_loading()}</p> : null}
      {query.error ? (
        <Alert tone="danger" role="alert">
          <p>{m.procurement_stock_owner_unavailable()}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {query.data
        ? manualLines.map((line) => (
            <section key={line.id}>
              <h3>{line.sku}</h3>
              {query.data.ownedLineIds.includes(line.id) ? (
                <NativeReceiptBooking
                  organizationId={organizationId}
                  orderId={record.order.id}
                  lineId={line.id}
                  reviews={query.data.items.filter(
                    (review) =>
                      review.command.purchaseReceipt?.lineId === line.id,
                  )}
                  changed={changed}
                />
              ) : (
                <AppExtension
                  appId="shopify"
                  organizationId={organizationId}
                  slot="inventory"
                  inventory={{
                    receipt: {
                      purchaseOrderId: record.order.id,
                      lineId: line.id,
                    },
                  }}
                  done={changed}
                />
              )}
            </section>
          ))
        : null}
    </section>
  );
}

type Reviews = Awaited<
  ReturnType<typeof api.nativeStock.purchaseReceiptReviews>
>['items'];

function NativeReceiptBooking({
  organizationId,
  orderId,
  lineId,
  reviews,
  changed,
}: {
  organizationId: string;
  orderId: string;
  lineId: string;
  reviews: Reviews;
  changed: () => Promise<void>;
}) {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const identity = useQuery(contextOptions(organizationId));
  const manage = useCan(organizationId, 'inventory.manage');
  const prepare = useMutation({
    mutationFn: async () =>
      api.nativeStock.preparePurchaseReceipt({
        params: { organizationId },
        body: { id, purchaseOrderId: orderId, lineId, reason },
      }),
    onSuccess: async () => {
      setUncertain(false);
      setId(crypto.randomUUID());
      setReason('');
      await changed();
    },
    onError: () => setUncertain(true),
  });

  return (
    <Card as="section" className="procurement-section">
      <h3>{m.procurement_stock_native_title()}</h3>
      <p>{m.procurement_stock_native_note()}</p>
      {manage ? (
        <form
          className="procurement-form"
          onSubmit={(event) => {
            event.preventDefault();
            prepare.mutate();
          }}
        >
          <label>
            {m.procurement_respond_note()}
            <Input
              required
              value={reason}
              maxLength={1024}
              disabled={prepare.isPending || uncertain}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={prepare.isPending}>
            {uncertain ? m.common_retry() : m.procurement_stock_propose()}
          </Button>
        </form>
      ) : null}
      {prepare.error ? (
        <Alert tone="danger" role="alert">
          {procurementError(prepare.error)}
        </Alert>
      ) : null}
      {reviews.map((review) => (
        <NativeReceiptReview
          key={review.id}
          organizationId={organizationId}
          review={review}
          actorId={identity.data?.actor.id}
          changed={changed}
        />
      ))}
    </Card>
  );
}

function NativeReceiptReview({
  organizationId,
  review,
  actorId,
  changed,
}: {
  organizationId: string;
  review: Reviews[number];
  actorId?: string | undefined;
  changed: () => Promise<void>;
}) {
  const canApprove = useCan(organizationId, 'inventory.approve');
  const canManage = useCan(organizationId, 'inventory.manage');
  const params = { organizationId, reviewId: review.id };
  const verification = useQuery({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'procurement',
      'receipt-stock-verification',
      review.id,
    ],
    enabled: review.state === 'approved',
    queryFn: ({ signal }) =>
      api.nativeStock.verifyPurchaseReceipt({ params }, { signal }),
  });
  const command = useMutation({
    mutationFn: async (action: 'approve' | 'reject' | 'apply') =>
      action === 'apply'
        ? api.nativeStock.applyLedger({ params })
        : api.nativeStock.reviewLedger({
            params,
            body: { approved: action === 'approve' },
          }),
    onSuccess: async () => {
      await changed();
      await verification.refetch();
    },
  });
  const verified = verification.data?.outcome === 'verified';
  const posted = !!verification.data?.receipt;

  return (
    <section className="procurement-section">
      <Badge
        tone={
          verified
            ? 'success'
            : review.state === 'rejected'
              ? 'danger'
              : 'neutral'
        }
      >
        {verified
          ? m.procurement_stock_verified()
          : posted
            ? m.procurement_stock_unverified()
            : review.state === 'pending'
              ? m.procurement_stock_approval()
              : review.state === 'rejected'
                ? m.procurement_stock_denied()
                : m.procurement_stock_native_approved()}
      </Badge>
      <ul>
        {review.command.postings
          .filter((posting) =>
            ['available', 'damaged'].includes(posting.account.state),
          )
          .map((posting) => (
            <li key={posting.account.state}>
              {posting.account.state === 'available'
                ? m.procurement_stock_good()
                : m.procurement_stock_damaged()}
              : {formatExactQuantity(posting.quantity)}
            </li>
          ))}
      </ul>
      <p>{review.command.reason}</p>
      {review.state === 'pending' &&
      canApprove &&
      !!actorId &&
      actorId !== review.preparedBy ? (
        <>
          <Button
            disabled={command.isPending}
            onClick={() => command.mutate('approve')}
          >
            {m.shopify_stock_approve()}
          </Button>
          <Button
            variant="outline"
            disabled={command.isPending}
            onClick={() => command.mutate('reject')}
          >
            {m.shopify_stock_reject()}
          </Button>
        </>
      ) : null}
      {review.state === 'approved' &&
      canManage &&
      actorId === review.preparedBy &&
      !posted ? (
        <Button
          disabled={command.isPending}
          onClick={() => command.mutate('apply')}
        >
          {m.procurement_stock_apply()}
        </Button>
      ) : null}
      {review.state === 'approved' ? (
        <Button
          variant="outline"
          disabled={verification.isFetching}
          onClick={() => void verification.refetch()}
        >
          {m.procurement_stock_check()}
        </Button>
      ) : null}
      {command.error ? (
        <Alert tone="danger" role="alert">
          {procurementError(command.error)}
        </Alert>
      ) : null}
      {verification.error ? (
        <Alert tone="warning">{m.procurement_stock_native_unverified()}</Alert>
      ) : null}
      {posted && !verified ? (
        <Alert tone="warning">{m.procurement_stock_native_unverified()}</Alert>
      ) : null}
    </section>
  );
}
