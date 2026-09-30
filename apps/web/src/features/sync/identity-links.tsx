import './sync.css';

import type { IdentityDetail, LinkInput } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Link2, Unlink } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { IdentityError } from '../identity/data';
import { identityKey, identityOptions, requestLink } from './data';
import { providerName, sourceId } from './presentation';

export type IdentitySuggestion = IdentityDetail['suggestions'][number];

type Source = IdentityDetail['sources'][number];

type Pending =
  | {
      operation: 'link';
      otherId: string;
      label: string;
      reason: string;
      sources?: Source[];
    }
  | { operation: 'unlink'; source: Source };

/**
 * Loads linked source records and lets owners and admins confirm matches in other
 * sources or separate a source again. Refreshes `onChanged` data once a request completes.
 */
export function IdentityLinks({
  organizationId,
  entityId,
  onChanged,
  kind = 'sku',
  lookup,
}: {
  organizationId: string;
  entityId: string;
  onChanged: () => void;
  kind?: IdentityDetail['entity']['kind'];
  lookup?: (
    detail: IdentityDetail,
    choose: (suggestion: IdentitySuggestion) => void,
  ) => ReactNode;
}) {
  const query = useQuery(identityOptions(organizationId, kind, entityId));
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // Requests sent from this view; stock data refreshes when one completes.
  const watching = useRef(new Set<string>());
  useEffect(() => {
    for (const request of query.data?.requests ?? []) {
      if (request.state === 'requested' || request.state === 'running')
        watching.current.add(request.id);
      if (
        (request.state === 'completed' || request.state === 'failed') &&
        watching.current.delete(request.id)
      )
        onChanged();
    }
  }, [query.data, onChanged]);

  async function submit(input: LinkInput) {
    setError(null);
    try {
      const request = await requestLink(organizationId, input);
      watching.current.add(request.id);
      await client.invalidateQueries({
        queryKey: identityKey(organizationId, kind, entityId),
      });
    } catch (cause) {
      setError(
        cause instanceof IdentityError && cause.message
          ? cause.message
          : 'Luma could not send this request. Try again.',
      );
      throw cause;
    }
  }

  if (query.isPending)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Linked sources</CardTitle>
        </CardHeader>
        <CardContent>
          <p role="status" className="sync-identity-note">
            Loading linked sources…
          </p>
        </CardContent>
      </Card>
    );
  const detail = query.data;
  if (!detail)
    return (
      <Alert tone="danger" role="alert">
        Linked sources could not be loaded.{' '}
        <Button variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </Alert>
    );

  return (
    <IdentityLinksView
      organizationId={organizationId}
      detail={detail}
      error={error}
      submit={submit}
      lookup={lookup ? (choose) => lookup(detail, choose) : undefined}
    />
  );
}

/** Presents source records, suggested matches and the latest link request. */
export function IdentityLinksView({
  organizationId,
  detail,
  error = null,
  submit,
  lookup,
}: {
  organizationId?: string;
  detail: IdentityDetail;
  error?: string | null;
  submit: (input: LinkInput) => Promise<void> | void;
  lookup?:
    | ((choose: (suggestion: IdentitySuggestion) => void) => ReactNode)
    | undefined;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const order = detail.entity.kind === 'order';
  const noun = order
    ? 'order'
    : detail.entity.kind === 'location'
      ? 'location'
      : 'SKU';
  const latest = detail.requests[0];
  const busy =
    sending || latest?.state === 'requested' || latest?.state === 'running';
  const open = (next: Pending) => {
    setPending(next);
    setReason(next.operation === 'link' ? next.reason : '');
  };

  return (
    <Card className="sync-identity" as="section">
      <CardHeader>
        <div>
          <CardTitle>Linked sources</CardTitle>
          <CardDescription>
            {order ? (
              'Confirm which source records represent this order. Each source keeps its own lines, shipments and evidence. Suggestions are never linked automatically.'
            ) : (
              <>
                Each source keeps its own ID. Luma treats records from different
                sources as the same {noun} only after a person links them.
              </>
            )}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="sync-identity-sources">
          {detail.sources.map((source) => (
            <li key={`${source.connectionId}:${source.externalId}`}>
              <span className="sync-identity-source">
                <strong>{source.connectionLabel}</strong>
                <small>
                  <span title={source.externalId}>
                    {providerName(source.provider)} ID{' '}
                    {sourceId(source.externalId)}
                  </span>
                  {source.order?.number
                    ? ` · Order ${source.order.number}`
                    : ''}
                  {source.codes.length
                    ? ` · SKU ${source.codes.join(', ')}`
                    : ''}
                  {source.titles.length ? ` · ${source.titles[0]}` : ''}
                </small>
              </span>
              <Badge tone={source.revisedAt ? 'info' : 'neutral'}>
                {source.method.startsWith('Linked')
                  ? 'Linked by a person'
                  : source.method.startsWith('Unlinked')
                    ? 'Unlinked'
                    : source.method.startsWith('Imported')
                      ? 'Imported'
                      : 'Mapped'}
              </Badge>
              {detail.canManage && detail.sources.length > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => open({ operation: 'unlink', source })}
                >
                  <Unlink aria-hidden="true" /> Unlink
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {detail.suggestions.length ? (
          <div className="sync-identity-suggestions">
            <h3>Possibly the same {noun}</h3>
            {order && detail.suggestions.length > 1 ? (
              <Alert>
                More than one order shares this reference. Check each source
                record before choosing.
              </Alert>
            ) : null}
            <ul className="sync-identity-sources">
              {detail.suggestions.map((suggestion) => (
                <li key={suggestion.id}>
                  <span className="sync-identity-source">
                    <strong>
                      {order && organizationId ? (
                        <Link
                          to="/app/$organizationId/orders/$orderId"
                          params={{ organizationId, orderId: suggestion.id }}
                        >
                          {suggestion.label}
                        </Link>
                      ) : (
                        suggestion.label
                      )}
                    </strong>
                    <small>
                      {suggestion.reason} ·{' '}
                      {suggestion.sources
                        .map((source) => source.connectionLabel)
                        .join(', ')}
                    </small>
                    {order ? (
                      <OrderMatchFacts sources={suggestion.sources} />
                    ) : null}
                  </span>
                  {detail.canManage ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        open({
                          operation: 'link',
                          otherId: suggestion.id,
                          label: suggestion.label,
                          reason: order
                            ? ''
                            : `${suggestion.reason}; confirmed as the same item`,
                          sources: suggestion.sources,
                        })
                      }
                    >
                      <Link2 aria-hidden="true" /> Link
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {detail.canManage && lookup
          ? lookup((suggestion) =>
              open({
                operation: 'link',
                otherId: suggestion.id,
                label: suggestion.label,
                reason: '',
                sources: suggestion.sources,
              }),
            )
          : null}
        {latest ? (
          latest.state === 'failed' ? (
            <Alert tone="danger" role="alert">
              {latest.message ?? 'The last request failed.'}
            </Alert>
          ) : busy ? (
            <Alert role="status">
              {latest.operation === 'link' ? 'Linking' : 'Unlinking'} records.
              {order
                ? 'Luma is updating the order and its source records.'
                : 'Luma is regrouping stock, products and order lines.'}
            </Alert>
          ) : (
            <p className="sync-identity-note">
              Last change: {latest.operation === 'link' ? 'linked' : 'unlinked'}{' '}
              <WorkspaceDate value={latest.completedAt ?? latest.createdAt} />.{' '}
              {latest.reason}
            </p>
          )
        ) : null}
        {error ? (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        ) : null}
        <Dialog
          open={pending !== null}
          onOpenChange={(value) => (value ? null : setPending(null))}
        >
          <DialogContent>
            <DialogTitle>
              {pending?.operation === 'link'
                ? `Link ${pending.label} to ${detail.entity.label}?`
                : `Unlink ${pending?.operation === 'unlink' ? pending.source.connectionLabel : ''}?`}
            </DialogTitle>
            <DialogDescription>
              {order
                ? pending?.operation === 'link'
                  ? 'Both source versions will appear on this order. Lines and shipments stay separate. Old links and evidence remain reachable. You can unlink later.'
                  : 'This source becomes a separate order again, with its own lines and shipments. The change and your reason are recorded.'
                : pending?.operation === 'link'
                  ? 'Luma will treat both records as one SKU: stock, products and order lines from each source are grouped here, while each source keeps its own quantities. You can unlink later; the change is recorded.'
                  : 'This source becomes its own SKU again. Its stock, products and order lines move with it. The change is recorded.'}
            </DialogDescription>
            {order && pending?.operation === 'link' ? (
              <div className="sync-order-match">
                <Card variant="subtle">
                  <h3>{detail.entity.label}</h3>
                  <OrderMatchFacts sources={detail.sources} />
                </Card>
                <Card variant="subtle">
                  <h3>{pending.label}</h3>
                  <OrderMatchFacts sources={pending.sources ?? []} />
                </Card>
              </div>
            ) : null}
            {error ? (
              <Alert tone="danger" role="alert">
                {error}
              </Alert>
            ) : null}
            <label className="sync-identity-reason">
              <span>Why is this correct?</span>
              <Textarea
                value={reason}
                maxLength={2000}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <div className="sync-dialog-actions">
              <Button variant="outline" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                disabled={!reason.trim() || sending}
                onClick={async () => {
                  if (!pending || sending) return;
                  setSending(true);
                  try {
                    await submit(
                      pending.operation === 'link'
                        ? {
                            operation: 'link',
                            kind: detail.entity.kind,
                            entityId: detail.entity.id,
                            otherId: pending.otherId,
                            reason: reason.trim(),
                          }
                        : {
                            operation: 'unlink',
                            kind: detail.entity.kind,
                            entityId: detail.entity.id,
                            connectionId: pending.source.connectionId,
                            reason: reason.trim(),
                          },
                    );
                    setPending(null);
                  } catch {
                    /* The requester displays the error and keeps the reason for retry. */
                  } finally {
                    setSending(false);
                  }
                }}
              >
                {pending?.operation === 'link'
                  ? 'Link records'
                  : 'Unlink source'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

/** Source facts supporting an order match; missing facts stay visibly unknown. */
export function OrderMatchFacts({ sources }: { sources: Source[] }) {
  return (
    <div className="sync-order-facts">
      {sources.map((source) => (
        <div
          key={`${source.connectionId}:${source.scopeKey}:${source.externalId}`}
        >
          <strong>{source.connectionLabel}</strong>
          <small>
            {providerName(source.provider)} ID {sourceId(source.externalId)}
          </small>
          {source.order?.externalNumber ? (
            <small>External order number: {source.order.externalNumber}</small>
          ) : null}
          <small>
            Placed:{' '}
            {source.order?.placedAt ? (
              <WorkspaceDate value={source.order.placedAt} />
            ) : (
              'Unknown'
            )}
          </small>
          <small>
            Total:{' '}
            {source.order?.total
              ? `${source.order.total.amount} ${source.order.total.currency}`
              : 'Unknown'}
          </small>
        </div>
      ))}
    </div>
  );
}
