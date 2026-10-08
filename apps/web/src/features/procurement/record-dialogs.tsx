import type {
  Attention,
  Commitment,
  PurchaseOrderRecord,
  Supplier,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { quantityWithUnit } from '@luma/ui/lib/units';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import {
  linkSupplier,
  procurementError,
  purchasingConnectionsOptions,
  purchasingSuppliersOptions,
  recordCommitment,
  recordMessage,
  requestSubmission,
  respondToAttention,
} from './data';
import { useCommand } from './forms';
import {
  addDays,
  calendarDate,
  commitmentKinds,
  quantity,
  today,
} from './presentation';

function Footer({
  command,
  close,
  label,
  pending,
  disabled = false,
}: {
  command: {
    locked: boolean;
    isPending: boolean;
    uncertain: boolean;
    error: unknown;
  };
  close: () => void;
  label: string;
  pending: string;
  disabled?: boolean;
}) {
  return (
    <>
      {command.error ? (
        <Alert tone="danger" role="alert">
          {procurementError(command.error)}
        </Alert>
      ) : null}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={command.locked}
          onClick={close}
        >
          {m.common_cancel()}
        </Button>
        <Button type="submit" disabled={command.isPending || disabled}>
          {command.isPending
            ? pending
            : command.uncertain
              ? m.common_retry()
              : label}
        </Button>
      </DialogFooter>
    </>
  );
}

function Frame({
  title,
  description,
  locked,
  close,
  wide = false,
  children,
}: {
  title: string;
  description: React.ReactNode;
  locked: boolean;
  close: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) close();
      }}
    >
      <DialogContent
        showCloseButton={!locked}
        className={wide ? 'procurement-wide-dialog' : undefined}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Requests approval to place an order in the supplier's purchasing system. Shows exactly what
 * will be sent; someone else who can approve changes approves it.
 */
export function SubmitDialog({
  organizationId,
  record,
  close,
}: {
  organizationId: string;
  record: PurchaseOrderRecord;
  close: () => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [date, setDate] = useState(() => addDays(today(), 7));
  const command = useCommand(
    organizationId,
    (body: { id: string; requestedDeliveryDate: string }) =>
      requestSubmission(organizationId, record.order.id, body),
    close,
  );
  const system = record.readiness.connection?.label;
  const supplier = record.supplier?.link?.name ?? record.order.supplierName;

  return (
    <Frame
      title={m.procurement_submit_title()}
      description={
        system
          ? m.procurement_submit_description({ system, supplier })
          : m.procurement_submit_description_generic({ supplier })
      }
      locked={command.locked}
      close={close}
      wide
    >
      <form
        className="procurement-form"
        onSubmit={(e) => {
          e.preventDefault();
          command.submit({ id, requestedDeliveryDate: date });
        }}
      >
        <fieldset disabled={command.locked}>
          <label>
            {m.procurement_submit_delivery_date()}
            <Input
              type="date"
              required
              min={today()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <div className="procurement-send-summary">
            <h3>{m.procurement_submit_summary()}</h3>
            <ul>
              {record.order.lines.map((line) => (
                <li key={line.id}>
                  <span>
                    <strong>
                      {quantityWithUnit(
                        quantity(line.quantity),
                        line.unit,
                        line.quantity,
                      )}
                    </strong>{' '}
                    {line.description}
                  </span>
                  <code>{line.sku}</code>
                </li>
              ))}
            </ul>
            <p>
              {system
                ? m.procurement_submit_prices({ system })
                : m.procurement_submit_prices_generic()}
            </p>
          </div>
        </fieldset>
        <Footer
          command={command}
          close={close}
          label={m.procurement_submit_request()}
          pending={m.procurement_submit_requesting()}
        />
      </form>
    </Frame>
  );
}

const channelOptions = () => [
  { value: 'email', label: m.procurement_channel_email() },
  { value: 'portal', label: m.procurement_channel_portal() },
  { value: 'phone', label: m.procurement_channel_phone() },
  { value: 'other', label: m.procurement_channel_other() },
];

const localNow = () => {
  const now = new Date();

  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};

/** Records a supplier message for this order. With a model configured, Luma reads it. */
export function MessageDialog({
  organizationId,
  record,
  close,
}: {
  organizationId: string;
  record: PurchaseOrderRecord;
  close: () => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [channel, setChannel] = useState<
    'email' | 'portal' | 'phone' | 'other'
  >('email');
  const [from, setFrom] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [receivedAt, setReceivedAt] = useState(localNow);
  const [messageId, setMessageId] = useState('');
  const command = useCommand(
    organizationId,
    (input: Parameters<typeof recordMessage>[2]) =>
      recordMessage(organizationId, record.order.id, input),
    close,
  );

  return (
    <Frame
      title={m.procurement_message_dialog_title()}
      description={
        record.extraction.available
          ? m.procurement_message_dialog_description_read()
          : m.procurement_message_dialog_description_manual()
      }
      locked={command.locked}
      close={close}
      wide
    >
      <form
        className="procurement-form"
        onSubmit={(e) => {
          e.preventDefault();
          command.submit({
            id,
            channel,
            from,
            subject,
            body,
            receivedAt: new Date(receivedAt).toISOString(),
            messageId: messageId.trim() || null,
          });
        }}
      >
        <fieldset disabled={command.locked}>
          <div className="procurement-form-pair">
            <label>
              {m.procurement_message_dialog_from()}
              <Input
                autoFocus
                required
                maxLength={320}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="orders@supplier.example"
              />
            </label>
            <label>
              {m.procurement_message_dialog_received()}
              <Input
                type="datetime-local"
                required
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
              />
            </label>
          </div>
          <div className="procurement-form-pair">
            <label>
              {m.procurement_message_dialog_channel()}
              <Select
                aria-label={m.procurement_message_dialog_channel()}
                value={channel}
                options={channelOptions()}
                onValueChange={(value) =>
                  setChannel((value as typeof channel) ?? 'email')
                }
              />
            </label>
            <label>
              {m.procurement_message_dialog_subject()}
              <Input
                maxLength={500}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={m.procurement_message_dialog_subject_placeholder({
                  order: record.order.reference,
                })}
              />
            </label>
          </div>
          <label>
            {m.procurement_message_dialog_message()}
            <Textarea
              required
              rows={8}
              maxLength={20_000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={m.procurement_message_dialog_message_placeholder()}
            />
          </label>
          <details className="procurement-external-fields">
            <summary>
              {m.procurement_message_dialog_id()}{' '}
              <span>{m.common_optional()}</span>
            </summary>
            <p>{m.procurement_message_dialog_id_description()}</p>
            <Input
              aria-label={m.procurement_message_dialog_id()}
              maxLength={250}
              value={messageId}
              onChange={(e) => setMessageId(e.target.value)}
              placeholder="<abc123@supplier.example>"
            />
          </details>
        </fieldset>
        <Footer
          command={command}
          close={close}
          label={
            record.extraction.available
              ? m.procurement_message_dialog_add_read()
              : m.procurement_messages_add()
          }
          pending={m.procurement_message_dialog_adding()}
        />
      </form>
    </Frame>
  );
}

/** A quote the commitment cites, or a commitment it corrects. */
export type CommitmentDraft =
  | {
      mode: 'message';
      communicationId: string;
      span: { start: number; end: number };
      quote: string;
    }
  | { mode: 'correction'; commitment: Commitment };

/** Records what a supplier stated, citing their words, or corrects a commitment with a reason. */
export function CommitmentDialog({
  organizationId,
  record,
  draft,
  close,
}: {
  organizationId: string;
  record: PurchaseOrderRecord;
  draft: CommitmentDraft;
  close: () => void;
}) {
  const prior = draft.mode === 'correction' ? draft.commitment : null;
  const [id] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<Exclude<Commitment['kind'], 'received'>>(
    prior && prior.kind !== 'received' ? prior.kind : 'confirmed_quantity',
  );
  const [lineId, setLineId] = useState(
    prior?.lineId ?? record.order.lines[0]?.id ?? '',
  );
  const [amount, setAmount] = useState(
    prior?.quantity !== undefined && prior?.quantity !== null
      ? String(prior.quantity)
      : '',
  );
  const [date, setDate] = useState(prior?.date ?? '');
  const [text, setText] = useState(prior?.text ?? '');
  const [reason, setReason] = useState('');
  const command = useCommand(
    organizationId,
    (body: Parameters<typeof recordCommitment>[2]) =>
      recordCommitment(organizationId, record.order.id, body),
    close,
  );
  const needsLine = kind === 'confirmed_quantity';

  return (
    <Frame
      title={
        prior
          ? m.procurement_commitment_dialog_correct_title()
          : m.procurement_commitment_dialog_record_title()
      }
      description={
        prior
          ? m.procurement_commitment_dialog_correct_description()
          : m.procurement_commitment_dialog_record_description()
      }
      locked={command.locked}
      close={close}
    >
      <form
        className="procurement-form"
        onSubmit={(e) => {
          e.preventDefault();
          command.submit({
            id,
            kind,
            lineId: needsLine || lineId ? lineId || null : null,
            quantity: kind === 'confirmed_quantity' ? Number(amount) : null,
            date:
              kind === 'promised_date' || kind === 'shipped'
                ? date || null
                : null,
            text: kind === 'condition' ? text : null,
            communicationId:
              draft.mode === 'message' ? draft.communicationId : null,
            span: draft.mode === 'message' ? draft.span : null,
            supersedes: prior?.id ?? null,
            reason: prior ? reason : null,
          });
        }}
      >
        {draft.mode === 'message' ? (
          <blockquote className="procurement-quote">
            {m.procurement_quote({ quote: draft.quote })}
          </blockquote>
        ) : null}
        <fieldset disabled={command.locked}>
          <div className="procurement-form-pair">
            <label>
              {m.procurement_commitment_dialog_kind()}
              <Select
                aria-label={m.procurement_commitment_dialog_kind()}
                value={kind}
                disabled={!!prior}
                options={(
                  [
                    'confirmed_quantity',
                    'promised_date',
                    'shipped',
                    'condition',
                  ] as const
                ).map((value) => ({ value, label: commitmentKinds[value]() }))}
                onValueChange={(value) =>
                  setKind((value as typeof kind) ?? 'confirmed_quantity')
                }
              />
            </label>
            <label>
              {m.procurement_commitment_dialog_line()}
              <Select
                aria-label={m.procurement_commitment_dialog_line()}
                value={lineId}
                disabled={!!prior}
                options={[
                  ...(needsLine
                    ? []
                    : [{ value: '', label: m.procurement_whole_order() }]),
                  ...record.order.lines.map((line) => ({
                    value: line.id,
                    label: `${line.sku} · ${line.description}`,
                  })),
                ]}
                onValueChange={(value) => setLineId(value ?? '')}
              />
            </label>
          </div>
          {kind === 'confirmed_quantity' ? (
            <label>
              {m.procurement_commitment_kind_confirmed_quantity()}
              <Input
                type="number"
                min="0"
                step="any"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
          ) : kind === 'condition' ? (
            <label>
              {m.procurement_commitment_kind_condition()}
              <Input
                required
                maxLength={300}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={m.procurement_commitment_dialog_condition_placeholder()}
              />
            </label>
          ) : (
            <label>
              {kind === 'shipped'
                ? m.procurement_commitment_dialog_shipped_on()
                : m.procurement_commitment_dialog_delivery_date()}
              <Input
                type="date"
                required={kind === 'promised_date'}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
          )}
          {prior ? (
            <label>
              {m.procurement_commitment_dialog_reason()}
              <Input
                required
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={m.procurement_commitment_dialog_reason_placeholder()}
              />
            </label>
          ) : null}
        </fieldset>
        <Footer
          command={command}
          close={close}
          label={
            prior
              ? m.procurement_commitment_dialog_add_correction()
              : m.procurement_commitment_dialog_record()
          }
          pending={m.common_saving()}
        />
      </form>
    </Frame>
  );
}

/** Accepts a supplier change, or records a follow-up and when Luma should check again. */
export function RespondDialog({
  organizationId,
  orderId,
  attention,
  close,
}: {
  organizationId: string;
  orderId: string;
  attention: Attention;
  close: () => void;
}) {
  const change = attention.kind === 'commitment_changed';
  const [id] = useState(() => crypto.randomUUID());
  const [response, setResponse] = useState<'accepted' | 'following_up'>(
    change ? 'accepted' : 'following_up',
  );
  const [note, setNote] = useState('');
  const [next, setNext] = useState(() => addDays(today(), 2));
  const command = useCommand(
    organizationId,
    (body: Parameters<typeof respondToAttention>[2]) =>
      respondToAttention(organizationId, orderId, body),
    close,
  );

  return (
    <Frame
      title={
        change
          ? m.procurement_respond_change_title()
          : m.procurement_respond_follow_up_title()
      }
      description={attention.summary}
      locked={command.locked}
      close={close}
    >
      <form
        className="procurement-form"
        onSubmit={(e) => {
          e.preventDefault();
          command.submit({
            id,
            key: attention.key,
            response,
            note,
            nextCheckAt:
              response === 'following_up'
                ? new Date(`${next}T09:00:00`).toISOString()
                : null,
          });
        }}
      >
        <fieldset disabled={command.locked}>
          {change ? (
            <div
              className="procurement-choice"
              role="radiogroup"
              aria-label={m.procurement_respond_response()}
            >
              {(
                [
                  [
                    'accepted',
                    m.procurement_respond_accept,
                    m.procurement_respond_accept_hint,
                  ],
                  [
                    'following_up',
                    m.procurement_respond_follow_up,
                    m.procurement_respond_follow_up_hint,
                  ],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} data-selected={response === value}>
                  <input
                    type="radio"
                    name="response"
                    value={value}
                    checked={response === value}
                    onChange={() => setResponse(value)}
                  />
                  <span>
                    <strong>{label()}</strong>
                    <small>{hint()}</small>
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          <label>
            {response === 'accepted'
              ? m.procurement_respond_note()
              : m.procurement_respond_action()}
            <Input
              autoFocus
              required
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                response === 'accepted'
                  ? m.procurement_respond_note_placeholder()
                  : m.procurement_respond_action_placeholder()
              }
            />
          </label>
          {response === 'following_up' ? (
            <label>
              {m.procurement_respond_check_again()}
              <Input
                type="date"
                required
                min={addDays(today(), 1)}
                max={addDays(today(), 60)}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
              <small className="procurement-hint">
                {m.procurement_respond_check_again_hint({
                  date: calendarDate(next),
                })}
              </small>
            </label>
          ) : null}
        </fieldset>
        <Footer
          command={command}
          close={close}
          label={
            response === 'accepted'
              ? m.procurement_respond_accept_change()
              : m.procurement_respond_record_follow_up()
          }
          pending={m.common_saving()}
        />
      </form>
    </Frame>
  );
}

/** Links a supplier to its record in a connected purchasing system, with follow-up terms. */
export function LinkSupplierDialog({
  organizationId,
  supplier,
  close,
}: {
  organizationId: string;
  supplier: Supplier;
  close: () => void;
}) {
  const connections = useQuery(purchasingConnectionsOptions(organizationId));
  const usable = (connections.data ?? []).filter(
    (c) => c.status === 'active' && c.canListSuppliers,
  );
  const [connectionId, setConnectionId] = useState(
    supplier.link?.connectionId ?? '',
  );
  const selected = connectionId || usable[0]?.id || '';
  const suppliers = useQuery({
    ...purchasingSuppliersOptions(organizationId, selected),
    enabled: !!selected,
  });
  const [externalId, setExternalId] = useState(supplier.link?.externalId ?? '');
  const [hours, setHours] = useState(String(supplier.confirmationHours ?? 48));
  const command = useCommand(
    organizationId,
    (body: Parameters<typeof linkSupplier>[2]) =>
      linkSupplier(organizationId, supplier.id, body),
    close,
  );
  const match = suppliers.data?.items.find((s) => s.externalId === externalId);

  return (
    <Frame
      title={m.procurement_link_title()}
      description={m.procurement_link_description()}
      locked={command.locked}
      close={close}
    >
      <form
        className="procurement-form"
        onSubmit={(e) => {
          e.preventDefault();
          command.submit({
            expectedRevision: supplier.revision ?? 1,
            link:
              selected && externalId
                ? {
                    connectionId: selected,
                    externalId,
                    scopeKey: match?.scopeKey ?? '',
                  }
                : null,
            confirmationHours: Number(hours),
          });
        }}
      >
        <fieldset disabled={command.locked}>
          {connections.isPending ? (
            <p role="status">{m.procurement_link_loading()}</p>
          ) : !usable.length ? (
            <Alert tone="info">{m.procurement_link_no_connection()}</Alert>
          ) : (
            <>
              <label>
                {m.procurement_link_system()}
                <Select
                  aria-label={m.procurement_link_system()}
                  value={selected}
                  options={usable.map((c) => ({ value: c.id, label: c.label }))}
                  onValueChange={(value) => {
                    setConnectionId(value ?? '');
                    setExternalId('');
                  }}
                />
              </label>
              <label>
                {m.procurement_link_supplier()}
                <Select
                  aria-label={m.procurement_link_supplier()}
                  value={externalId}
                  disabled={suppliers.isPending || !!suppliers.error}
                  options={[
                    {
                      value: '',
                      label: suppliers.isPending
                        ? m.common_loading()
                        : m.procurement_not_linked(),
                    },
                    ...(suppliers.data?.items ?? []).map((s) => ({
                      value: s.externalId,
                      label: [
                        s.name ??
                          m.procurement_supplier_external({ id: s.externalId }),
                        s.number,
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    })),
                  ]}
                  onValueChange={(value) => setExternalId(value ?? '')}
                />
              </label>
              {suppliers.error ? (
                <Alert tone="warning">
                  {procurementError(suppliers.error)}
                </Alert>
              ) : null}
              {match?.email ? (
                <small className="procurement-hint">
                  {m.procurement_link_email({ email: match.email })}
                </small>
              ) : null}
            </>
          )}
          <label>
            {m.procurement_link_hours()}
            <Input
              type="number"
              min="1"
              max={24 * 30}
              step="1"
              required
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
            <small className="procurement-hint">
              {m.procurement_link_hours_hint()}
            </small>
          </label>
        </fieldset>
        <Footer
          command={command}
          close={close}
          label={m.procurement_link_save()}
          pending={m.common_saving()}
        />
      </form>
    </Frame>
  );
}
