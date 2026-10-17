import type {
  EvidenceItem,
  EvidenceList as EvidenceListData,
  EvidenceRecordKind,
  EvidenceSummaryField,
} from '@luma/api-contract';
import { formatRelativeTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Fragment, useContext } from 'react';

import { Badge } from '../primitives/badge';
import { Button } from '../primitives/button';
import { Spinner } from '../primitives/spinner';
import {
  formatWorkspaceDateTime,
  WorkspaceDate,
  WorkspaceTimezone,
} from '../primitives/workspace-date';

/** Where loading a record's evidence stands. */
export type EvidenceState =
  | { status: 'loading' }
  | { status: 'failed'; retry?: () => void }
  | { status: 'forbidden' }
  | { status: 'not_found' }
  | { status: 'unavailable' }
  | { status: 'ready'; evidence: EvidenceListData };

const recordLabels: Record<EvidenceRecordKind, () => string> = {
  purchase_order: m.evidence_record_purchase_order,
  purchasing_plan: m.evidence_record_purchasing_plan,
  order_change: m.evidence_record_order_change,
  submission: m.evidence_record_submission,
  commitment: m.evidence_record_commitment,
  supplier_message: m.evidence_record_supplier_message,
  follow_up: m.evidence_record_follow_up,
  policy_decision: m.evidence_record_policy_decision,
  approval: m.evidence_record_approval,
  return_case: m.evidence_record_return_case,
  return_creation: m.evidence_record_return_creation,
  return_settlement: m.evidence_record_return_settlement,
  return_exchange: m.evidence_record_return_exchange,
  return_exchange_step: m.evidence_record_return_exchange_step,
  thread: m.evidence_record_thread,
  reply: m.evidence_record_reply,
  case: m.evidence_record_case,
  case_proposal: m.evidence_record_case_proposal,
};

const summaryLabels: Record<EvidenceSummaryField, () => string> = {
  status: m.evidence_summary_status,
  state: m.evidence_summary_state,
  outcome: m.evidence_summary_outcome,
  payment: m.evidence_summary_payment,
  orderNumber: m.evidence_summary_order_number,
  number: m.evidence_summary_number,
  confirmed: m.evidence_summary_confirmed,
  requestedDeliveryDate: m.evidence_summary_requested_delivery_date,
  available: m.evidence_summary_available,
  onHand: m.evidence_summary_on_hand,
  quantity: m.evidence_summary_quantity,
  amount: m.evidence_summary_amount,
  currency: m.evidence_summary_currency,
  lines: m.evidence_summary_lines,
  complete: m.evidence_summary_complete,
};

/** Text labels and tones for each resolution; tone never carries meaning on its own. */
function kindBadge(resolution: EvidenceItem['resolution']) {
  switch (resolution.kind) {
    case 'read':
      return {
        tone: resolution.completeness === 'partial' ? 'warning' : 'info',
        label: m.evidence_kind_read(),
      } as const;
    case 'write_receipt':
      return { tone: 'info', label: m.evidence_kind_receipt() } as const;
    case 'luma_record':
      return { tone: 'neutral', label: m.evidence_kind_record() } as const;
    case 'not_retained':
      return {
        tone: 'neutral',
        label: m.evidence_kind_not_retained(),
      } as const;
    case 'unresolved':
      return { tone: 'warning', label: m.evidence_kind_unresolved() } as const;
  }
}

function summaryValue(value: string) {
  return value === 'true'
    ? m.evidence_yes()
    : value === 'false'
      ? m.evidence_no()
      : value;
}

/** A moment in workspace time with how long ago it was, such as "8 Oct 2026 14:05 · 5 minutes ago". */
function Moment({ value, now }: { value: string; now: number }) {
  return (
    <>
      <WorkspaceDate value={value} />
      <span className="evidence-age"> · {formatRelativeTime(value, now)}</span>
    </>
  );
}

function EvidenceEntry({
  item,
  now,
  providerName,
  capabilityName,
}: {
  item: EvidenceItem;
  now: number;
  providerName: (provider: string) => string;
  capabilityName: (capability: string) => string;
}) {
  const { resolution } = item;
  const badge = kindBadge(resolution);
  // A missing read or receipt the record relies on is a gap; an unknown reference is not.
  const citedEvidence =
    item.citedAs === 'read' || item.citedAs === 'write_receipt';

  return (
    <li className="evidence-entry" data-kind={resolution.kind}>
      <div className="evidence-entry-heading">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <strong>
          {resolution.kind === 'read'
            ? m.evidence_read_title({
                provider: providerName(resolution.provider),
                connection:
                  resolution.connection.label ??
                  m.evidence_connection_removed(),
              })
            : resolution.kind === 'write_receipt'
              ? m.evidence_receipt_title({
                  provider: providerName(resolution.provider),
                  connection:
                    resolution.connection.label ??
                    m.evidence_connection_removed(),
                })
              : resolution.kind === 'luma_record'
                ? recordLabels[resolution.record]()
                : resolution.kind === 'not_retained'
                  ? m.evidence_not_retained_title()
                  : citedEvidence
                    ? m.evidence_unresolved_title()
                    : m.evidence_unresolved_reference_title()}
        </strong>
      </div>
      {resolution.kind === 'read' ? (
        <>
          <dl className="evidence-facts">
            {resolution.record ? (
              <>
                <dt>{m.evidence_field_record()}</dt>
                <dd>
                  {resolution.record.resource}{' '}
                  <code>{resolution.record.externalId}</code>
                </dd>
              </>
            ) : null}
            <dt>{m.evidence_field_read_at()}</dt>
            <dd>
              <Moment value={resolution.observedAt} now={now} />
            </dd>
            <dt>{m.evidence_field_source_updated()}</dt>
            <dd>
              {resolution.sourceUpdatedAt ? (
                <WorkspaceDate value={resolution.sourceUpdatedAt} />
              ) : (
                m.evidence_not_reported()
              )}
            </dd>
            <dt>{m.evidence_field_revision()}</dt>
            <dd>{resolution.sourceRevision ?? m.evidence_not_reported()}</dd>
            <dt>{m.evidence_field_completeness()}</dt>
            <dd>
              {resolution.completeness === 'complete'
                ? m.evidence_complete()
                : resolution.completeness === 'partial'
                  ? m.evidence_partial()
                  : m.evidence_not_recorded()}
            </dd>
            <dt>{m.evidence_field_adapter()}</dt>
            <dd>{resolution.adapterVersion ?? m.evidence_not_recorded()}</dd>
          </dl>
          {resolution.summary.length ? (
            <>
              <p className="evidence-subheading">
                {m.evidence_summary_heading()}
              </p>
              <dl className="evidence-facts">
                {resolution.summary.map(({ field, value }) => (
                  <Fragment key={field}>
                    <dt>{summaryLabels[field]()}</dt>
                    <dd>{summaryValue(value)}</dd>
                  </Fragment>
                ))}
              </dl>
            </>
          ) : null}
        </>
      ) : resolution.kind === 'write_receipt' ? (
        <>
          <dl className="evidence-facts">
            <dt>{m.evidence_field_capability()}</dt>
            <dd>
              {resolution.capability
                ? capabilityName(resolution.capability)
                : m.evidence_not_recorded()}
            </dd>
            <dt>{m.evidence_field_accepted_at()}</dt>
            <dd>
              <Moment value={resolution.acceptedAt} now={now} />
            </dd>
            <dt>{m.evidence_field_provider_records()}</dt>
            <dd>
              {resolution.records.length ? (
                <ul className="evidence-records">
                  {resolution.records.map((record) => (
                    <li key={`${record.resource}:${record.externalId}`}>
                      {record.resource} <code>{record.externalId}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                m.evidence_not_reported()
              )}
            </dd>
            <dt>{m.evidence_field_request_id()}</dt>
            <dd>
              {resolution.providerRequestId ? (
                <code>{resolution.providerRequestId}</code>
              ) : (
                m.evidence_not_reported()
              )}
            </dd>
          </dl>
          <p className="evidence-note">{m.evidence_receipt_note()}</p>
        </>
      ) : resolution.kind === 'luma_record' ? (
        <p className="evidence-note">{m.evidence_record_note()}</p>
      ) : resolution.kind === 'not_retained' ? (
        <p className="evidence-note">
          <NotRetained since={resolution.retentionStartedAt} />
        </p>
      ) : (
        <p className="evidence-note">
          {citedEvidence
            ? m.evidence_unresolved_detail()
            : m.evidence_unresolved_reference_detail()}
        </p>
      )}
      <p className="evidence-reference">
        {m.evidence_field_reference()} <code>{item.ref}</code>
      </p>
    </li>
  );
}

/** Explains that the cited evidence predates storage, naming the workspace day storage began. */
function NotRetained({ since }: { since: string }) {
  const timeZone = useContext(WorkspaceTimezone);

  return (
    <>
      {m.evidence_not_retained_detail({
        date: formatWorkspaceDateTime(since, timeZone, 'day'),
      })}
    </>
  );
}

/**
 * Shows what a record cites: each provider read with its source, read time, freshness and
 * completeness; each write receipt with what was accepted; Luma records; and references whose
 * evidence was never kept or can't be found. Every state has a text label. Pass names for
 * providers and capabilities when the caller can localize them.
 */
export function EvidenceList({
  state,
  now,
  providerName = (provider) => provider,
  capabilityName = (capability) => capability,
}: {
  state: EvidenceState;
  /** The moment ages are measured from; defaults to when the server resolved the evidence. */
  now?: number;
  providerName?: (provider: string) => string;
  capabilityName?: (capability: string) => string;
}) {
  if (state.status === 'loading')
    return (
      <p className="evidence-status" role="status">
        <Spinner aria-hidden="true" /> {m.evidence_loading()}
      </p>
    );
  if (state.status === 'failed')
    return (
      <div className="evidence-status" role="alert">
        <p>{m.evidence_failed()}</p>
        {state.retry ? (
          <Button size="sm" variant="outline" onClick={state.retry}>
            {m.evidence_retry()}
          </Button>
        ) : null}
      </div>
    );
  if (state.status !== 'ready')
    return (
      <p className="evidence-status">
        {state.status === 'forbidden'
          ? m.evidence_forbidden()
          : state.status === 'not_found'
            ? m.evidence_not_found()
            : m.evidence_unavailable()}
      </p>
    );
  const { items, truncated } = state.evidence;
  if (!items.length)
    return <p className="evidence-status">{m.evidence_empty()}</p>;

  return (
    <div className="evidence-list">
      <ul aria-label={m.evidence_list_label()}>
        {items.map((item) => (
          <EvidenceEntry
            key={item.ref}
            item={item}
            now={now ?? Date.parse(state.evidence.asOf)}
            providerName={providerName}
            capabilityName={capabilityName}
          />
        ))}
      </ul>
      {truncated ? (
        <p className="evidence-status">
          {m.evidence_truncated({ count: items.length })}
        </p>
      ) : null}
    </div>
  );
}
