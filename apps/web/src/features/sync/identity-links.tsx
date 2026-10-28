import './sync.css';

import type { IdentityDetail, LinkInput } from '@luma/api-contract';
import { formatCurrency, formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
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

import { ApiError } from '../../kit/identity/data';
import { identityKey, identityOptions, requestLink } from './data';
import { linkMethodLabel, providerName, sourceId } from './presentation';

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
 * Loads linked source records and lets people who can manage imports confirm matches in other
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
        cause instanceof ApiError && cause.message
          ? cause.message
          : m.sync_links_request_failed(),
      );
      throw cause;
    }
  }

  if (query.isPending)
    return (
      <Card>
        <CardHeader>
          <CardTitle>{m.sync_links_title()}</CardTitle>
        </CardHeader>
        <CardContent>
          <p role="status" className="sync-identity-note">
            {m.sync_links_loading()}
          </p>
        </CardContent>
      </Card>
    );
  const detail = query.data;
  if (!detail)
    return (
      <Alert tone="danger" role="alert">
        {m.sync_links_load_failed()}{' '}
        <Button variant="outline" onClick={() => void query.refetch()}>
          {m.common_retry()}
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
  const line = detail.entity.kind === 'order_line';
  const location = detail.entity.kind === 'location';
  const latest = detail.requests[0];
  const busy =
    sending || latest?.state === 'requested' || latest?.state === 'running';
  const open = (next: Pending) => {
    setPending(next);
    setReason(next.operation === 'link' ? next.reason : '');
  };
  const confirm = async () => {
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
  };

  return (
    <Card className="sync-identity" as="section">
      <CardHeader>
        <div>
          <CardTitle>
            {line
              ? m.sync_links_title_line({ line: detail.entity.label })
              : m.sync_links_title()}
          </CardTitle>
          <CardDescription>
            {order
              ? m.sync_links_description_order()
              : line
                ? m.sync_links_description_line()
                : location
                  ? m.sync_links_description_location()
                  : m.sync_links_description_sku()}
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
                    {m.sync_links_source_id({
                      provider: providerName(source.provider),
                      id: sourceId(source.externalId),
                    })}
                  </span>
                  {source.order?.number
                    ? ` · ${m.sync_links_source_order({ number: source.order.number })}`
                    : ''}
                  {source.codes.length
                    ? ` · ${m.sync_links_source_sku({ codes: formatList(source.codes) })}`
                    : ''}
                  {source.titles.length ? ` · ${source.titles[0]}` : ''}
                </small>
              </span>
              <Badge tone={source.revisedAt ? 'info' : 'neutral'}>
                {linkMethodLabel(source.method)}
              </Badge>
              {detail.canManage && detail.sources.length > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => open({ operation: 'unlink', source })}
                >
                  <Unlink aria-hidden="true" /> {m.sync_links_unlink()}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {detail.suggestions.length ? (
          <div className="sync-identity-suggestions">
            <h3>
              {order
                ? m.sync_links_suggestions_order()
                : line
                  ? m.sync_links_suggestions_line()
                  : location
                    ? m.sync_links_suggestions_location()
                    : m.sync_links_suggestions_sku()}
            </h3>
            {order && detail.suggestions.length > 1 ? (
              <Alert>{m.sync_links_suggestions_ambiguous()}</Alert>
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
                      {order
                        ? m.sync_links_candidate_order()
                        : line
                          ? m.sync_links_candidate_line()
                          : suggestion.reason}{' '}
                      ·{' '}
                      {formatList(
                        suggestion.sources.map(
                          (source) => source.connectionLabel,
                        ),
                      )}
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
                          reason:
                            order || line
                              ? ''
                              : m.sync_links_reason_prefill({
                                  reason: suggestion.reason,
                                }),
                          sources: suggestion.sources,
                        })
                      }
                    >
                      <Link2 aria-hidden="true" /> {m.sync_links_link()}
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
              {latest.message ?? m.sync_links_last_failed()}
            </Alert>
          ) : busy ? (
            <Alert role="status">
              {latest.operation === 'link'
                ? order
                  ? m.sync_links_linking_order()
                  : line
                    ? m.sync_links_linking_line()
                    : m.sync_links_linking_sku()
                : order
                  ? m.sync_links_unlinking_order()
                  : line
                    ? m.sync_links_unlinking_line()
                    : m.sync_links_unlinking_sku()}
            </Alert>
          ) : (
            <p className="sync-identity-note">
              {rich(
                latest.operation === 'link'
                  ? m.sync_links_last_linked
                  : m.sync_links_last_unlinked,
                {
                  date: (
                    <WorkspaceDate
                      value={latest.completedAt ?? latest.createdAt}
                    />
                  ),
                },
              )}{' '}
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
                ? m.sync_links_link_title({
                    other: pending.label,
                    record: detail.entity.label,
                  })
                : m.sync_links_unlink_title({
                    source:
                      pending?.operation === 'unlink'
                        ? pending.source.connectionLabel
                        : '',
                  })}
            </DialogTitle>
            <DialogDescription>
              {order
                ? pending?.operation === 'link'
                  ? m.sync_links_link_order_description()
                  : m.sync_links_unlink_order_description()
                : line
                  ? pending?.operation === 'link'
                    ? m.sync_links_link_line_description()
                    : m.sync_links_unlink_line_description()
                  : location
                    ? pending?.operation === 'link'
                      ? m.sync_links_link_location_description()
                      : m.sync_links_unlink_location_description()
                    : pending?.operation === 'link'
                      ? m.sync_links_link_sku_description()
                      : m.sync_links_unlink_sku_description()}
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
              <span>{m.sync_links_reason_label()}</span>
              <Textarea
                value={reason}
                maxLength={2000}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <div className="sync-dialog-actions">
              <Button variant="outline" onClick={() => setPending(null)}>
                {m.common_cancel()}
              </Button>
              <Button
                disabled={!reason.trim() || sending}
                onClick={() => void confirm()}
              >
                {pending?.operation === 'link'
                  ? m.sync_links_link_confirm()
                  : m.sync_links_unlink_confirm()}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

/** Source facts supporting an order match; missing facts stay visibly unknown. */
function OrderMatchFacts({ sources }: { sources: Source[] }) {
  return (
    <div className="sync-order-facts">
      {sources.map((source) => (
        <div
          key={`${source.connectionId}:${source.scopeKey}:${source.externalId}`}
        >
          <strong>{source.connectionLabel}</strong>
          <small>
            {m.sync_links_source_id({
              provider: providerName(source.provider),
              id: sourceId(source.externalId),
            })}
          </small>
          {source.order?.externalNumber ? (
            <small>
              {m.sync_links_fact_external_number({
                number: source.order.externalNumber,
              })}
            </small>
          ) : null}
          <small>
            {rich(m.sync_links_fact_placed, {
              date: source.order?.placedAt ? (
                <WorkspaceDate value={source.order.placedAt} />
              ) : (
                m.common_unknown()
              ),
            })}
          </small>
          <small>
            {m.sync_links_fact_total({
              total: source.order?.total
                ? orderTotal(source.order.total)
                : m.common_unknown(),
            })}
          </small>
        </div>
      ))}
    </div>
  );
}

/** Formats a source order total in the active language, keeping the raw value if it isn’t numeric. */
function orderTotal(total: { amount: string; currency: string }) {
  const amount = Number(total.amount);
  if (!Number.isFinite(amount)) return `${total.amount} ${total.currency}`;
  try {
    return formatCurrency(amount, total.currency);
  } catch {
    return `${total.amount} ${total.currency}`;
  }
}
