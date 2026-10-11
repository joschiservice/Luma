import type { ReturnCaseDetail, ReturnDetail } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';

import { formatMoney } from '../../shared/orders/presentation';
import { returnEvidenceFreshness, returnReadIsFresh } from './case-evidence';
import { historyTitle, personName } from './case-presentation';

const money = (amount: string | null, currency: string | null) =>
  amount !== null && currency
    ? formatMoney({ amount, currency })
    : m.common_not_reported();

/** Shows customer-safe facts, keeping operator decisions and source financial evidence distinct. */
export function ReturnServiceSummary({
  detail,
  source,
  now = detail.asOf,
  loading = false,
  unavailable = false,
}: {
  detail: ReturnCaseDetail;
  source?: ReturnDetail | undefined;
  now?: string;
  loading?: boolean;
  unavailable?: boolean;
}) {
  const freshness = returnEvidenceFreshness(source, now);
  const receipt = detail.lines.reduce((sum, l) => sum + (l.received ?? 0), 0);

  return (
    <Card as="section" aria-label={m.returns_service_customer_title()}>
      <CardHeader>
        <CardTitle as="h2">{m.returns_service_customer_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <p>
          {detail.receipt
            ? m.returns_service_receipt_summary({
                units: formatNumber(receipt),
              })
            : m.returns_service_receipt_unknown()}
        </p>
        {detail.proposal ? <p>{m.returns_service_proposal_summary()}</p> : null}
        {loading ? (
          <p role="status">{m.returns_service_source_loading()}</p>
        ) : unavailable ? (
          <p role="status">{m.returns_service_source_unavailable()}</p>
        ) : freshness === 'missing' ? (
          <p>{m.returns_service_source_missing()}</p>
        ) : freshness === 'stale' ? (
          <p>{m.returns_service_source_stale()}</p>
        ) : source ? (
          <>
            <p>{m.returns_service_payment_scope()}</p>
            <dl className="returns-facts">
              <div>
                <dt>{m.returns_service_paid()}</dt>
                <dd>
                  {money(
                    source.item.refund.refunded,
                    source.item.refund.currency,
                  )}
                </dd>
              </div>
              <div>
                <dt>{m.returns_service_pending()}</dt>
                <dd>
                  {money(
                    source.item.refund.pending,
                    source.item.refund.currency,
                  )}
                </dd>
              </div>
              <div>
                <dt>{m.returns_service_failed()}</dt>
                <dd>{formatNumber(source.item.refund.failedAttempts)}</dd>
              </div>
            </dl>
            {source.item.refund.state === 'none' ||
            source.item.refund.state === 'recorded' ? (
              <p>{m.returns_service_payment_unconfirmed()}</p>
            ) : null}
          </>
        ) : null}
        {source ? (
          <small>
            {m.returns_service_source_read()}{' '}
            <WorkspaceDate value={source.item.observedAt} />
          </small>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Combines only reported source events with audited case decisions; unreported transitions stay absent. */
export function ReturnServiceTimeline({
  detail,
  source,
  now = detail.asOf,
}: {
  detail: ReturnCaseDetail;
  source?: ReturnDetail | undefined;
  now?: string;
}) {
  const label =
    source?.source?.label ??
    detail.order.connection.label ??
    m.returns_source_fallback();
  const stale = source
    ? !returnReadIsFresh(source, source.item.observedAt, now)
    : true;
  const entries: {
    id: string;
    at: string;
    title: string;
    source: string;
    actor: string;
    observedAt: string;
    stale: boolean;
    observedOnly: boolean;
    evidence: ReturnCaseDetail['history'][number]['evidence'];
  }[] = detail.history.map((e) => ({
    id: `case:${e.id}`,
    at: e.at,
    title: historyTitle(e, label),
    source: m.returns_service_luma(),
    actor: personName(e.actor),
    observedAt: '',
    stale: false,
    observedOnly: false,
    evidence: e.evidence,
  }));
  if (source) {
    const events = [
      [
        'requested',
        source.timeline.requestedAt,
        m.returns_service_event_requested(),
      ],
      [
        'approved',
        source.timeline.approvedAt,
        m.returns_service_event_approved(),
      ],
      [
        'received',
        source.timeline.receivedAt,
        m.returns_service_event_received(),
      ],
      ['closed', source.timeline.closedAt, m.returns_service_event_closed()],
    ] as const;
    for (const [kind, at, title] of events)
      if (at)
        entries.push({
          id: `source:${kind}:${at}`,
          at,
          title,
          source: label,
          actor: '',
          observedAt: source.item.observedAt,
          stale,
          observedOnly: false,
          evidence: null,
        });
    for (const refund of source.refunds) {
      if (refund.createdAt)
        entries.push({
          id: `refund:${refund.id}`,
          at: refund.createdAt,
          title: m.returns_service_event_refund_requested(),
          source: label,
          actor: '',
          observedAt: refund.observedAt,
          stale: !returnReadIsFresh(source, refund.observedAt, now),
          observedOnly: false,
          evidence: null,
        });
      refund.transactions.forEach((payment, i) =>
        entries.push({
          id: `payment:${refund.id}:${i}`,
          at: payment.processedAt ?? refund.observedAt,
          title: `${payment.status === 'success' ? m.returns_service_event_refund_paid() : payment.status === 'pending' ? m.returns_service_event_refund_pending() : payment.status === 'failed' ? m.returns_service_event_refund_failed() : m.common_not_reported()} · ${formatMoney(payment.amount)}`,
          source: label,
          actor: '',
          observedAt: refund.observedAt,
          stale: !returnReadIsFresh(source, refund.observedAt, now),
          observedOnly: !payment.processedAt,
          evidence: null,
        }),
      );
    }
  }
  entries.sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  );

  return (
    <Card as="section" aria-label={m.returns_service_timeline()}>
      <CardHeader>
        <CardTitle as="h2">{m.returns_service_timeline()}</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="returns-history">
          {entries.map((entry) => (
            <li key={entry.id}>
              <span className="returns-cell">
                <strong>{entry.title}</strong>
                <small>
                  {entry.source}
                  {entry.actor ? ` · ${entry.actor}` : ''} ·{' '}
                  {entry.observedOnly ? m.returns_service_observed() : null}{' '}
                  <WorkspaceDate value={entry.at} />
                </small>
                {entry.observedAt ? (
                  <small>
                    {m.returns_service_source_read()}{' '}
                    <WorkspaceDate value={entry.observedAt} />{' '}
                    {entry.stale ? (
                      <Badge tone="warning">{m.returns_service_stale()}</Badge>
                    ) : null}
                  </small>
                ) : null}
                {entry.evidence?.note ? <p>{entry.evidence.note}</p> : null}
                {entry.evidence?.link ? (
                  <a
                    href={entry.evidence.link}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {m.returns_service_evidence()}
                  </a>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
