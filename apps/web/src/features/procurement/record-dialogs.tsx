import type {
  Attention,
  Commitment,
  PurchaseOrderRecord,
  Supplier,
} from '@luma/api-contract';
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
          Cancel
        </Button>
        <Button type="submit" disabled={command.isPending || disabled}>
          {command.isPending ? pending : command.uncertain ? 'Retry' : label}
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
 * will be sent; a different owner or admin approves it.
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
  const connection =
    record.readiness.connection?.label ?? 'the purchasing system';
  const supplier = record.supplier?.link?.name ?? record.order.supplierName;

  return (
    <Frame
      title="Send to supplier"
      description={`Luma places this order in ${connection} for ${supplier} once a different owner or admin approves it. ${connection} then sends it to the supplier.`}
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
            Requested delivery date
            <Input
              type="date"
              required
              min={today()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <div className="procurement-send-summary">
            <h3>What will be sent</h3>
            <ul>
              {record.order.lines.map((line) => (
                <li key={line.id}>
                  <span>
                    <strong>
                      {quantity(line.quantity)} {line.unit}
                    </strong>{' '}
                    {line.description}
                  </span>
                  <code>{line.sku}</code>
                </li>
              ))}
            </ul>
            <p>
              Prices and tax come from {connection}’s supplier terms. Luma
              doesn’t set them.
            </p>
          </div>
        </fieldset>
        <Footer
          command={command}
          close={close}
          label="Request approval"
          pending="Requesting…"
        />
      </form>
    </Frame>
  );
}

const channelOptions = [
  { value: 'email', label: 'Email' },
  { value: 'portal', label: 'Supplier portal' },
  { value: 'phone', label: 'Phone call notes' },
  { value: 'other', label: 'Other' },
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
      title="Add supplier message"
      description={
        record.extraction.available
          ? 'Paste what the supplier wrote. Luma lists the commitments it states, each with the exact words it came from. Changes and unclear wording wait for your review.'
          : 'Paste what the supplier wrote, then select the words that state a commitment to record it. Automatic reading isn’t set up on this server.'
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
              From
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
              Received
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
              Channel
              <Select
                aria-label="Channel"
                value={channel}
                options={channelOptions}
                onValueChange={(value) =>
                  setChannel((value as typeof channel) ?? 'email')
                }
              />
            </label>
            <label>
              Subject
              <Input
                maxLength={500}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={`Re: ${record.order.reference}`}
              />
            </label>
          </div>
          <label>
            Message
            <Textarea
              required
              rows={8}
              maxLength={20_000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Paste the supplier’s reply"
            />
          </label>
          <details className="procurement-external-fields">
            <summary>
              Message ID <span>Optional</span>
            </summary>
            <p>
              The email’s Message-ID. The same message is recorded only once,
              even if it’s added again.
            </p>
            <Input
              aria-label="Message ID"
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
          label={record.extraction.available ? 'Add and read' : 'Add message'}
          pending="Adding…"
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
      title={prior ? 'Correct commitment' : 'Record what the supplier said'}
      description={
        prior
          ? 'Corrections are added to the history; the original stays visible.'
          : 'This counts as the supplier’s commitment and cites the words you selected.'
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
          <blockquote className="procurement-quote">“{draft.quote}”</blockquote>
        ) : null}
        <fieldset disabled={command.locked}>
          <div className="procurement-form-pair">
            <label>
              What it states
              <Select
                aria-label="What it states"
                value={kind}
                disabled={!!prior}
                options={(
                  [
                    'confirmed_quantity',
                    'promised_date',
                    'shipped',
                    'condition',
                  ] as const
                ).map((value) => ({ value, label: commitmentKinds[value] }))}
                onValueChange={(value) =>
                  setKind((value as typeof kind) ?? 'confirmed_quantity')
                }
              />
            </label>
            <label>
              Line
              <Select
                aria-label="Line"
                value={lineId}
                disabled={!!prior}
                options={[
                  ...(needsLine ? [] : [{ value: '', label: 'Whole order' }]),
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
              Confirmed quantity
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
              Condition
              <Input
                required
                maxLength={300}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="e.g. Freight surcharge of 40 EUR"
              />
            </label>
          ) : (
            <label>
              {kind === 'shipped' ? 'Shipped on' : 'Delivery date'}
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
              Reason for the correction
              <Input
                required
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. The supplier corrected the date by phone"
              />
            </label>
          ) : null}
        </fieldset>
        <Footer
          command={command}
          close={close}
          label={prior ? 'Add correction' : 'Record commitment'}
          pending="Saving…"
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
      title={change ? 'Accept or follow up' : 'Record a follow-up'}
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
              aria-label="Response"
            >
              {(
                [
                  [
                    'accepted',
                    'Accept the change',
                    'It becomes what Luma expects.',
                  ],
                  [
                    'following_up',
                    'Follow up with the supplier',
                    'Luma checks again on the date you choose.',
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
                    <strong>{label}</strong>
                    <small>{hint}</small>
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          <label>
            {response === 'accepted' ? 'Note' : 'What did you do?'}
            <Input
              autoFocus
              required
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                response === 'accepted'
                  ? 'e.g. Partial delivery is fine for this week'
                  : 'e.g. Emailed the supplier for a new date'
              }
            />
          </label>
          {response === 'following_up' ? (
            <label>
              Check again on
              <Input
                type="date"
                required
                min={addDays(today(), 1)}
                max={addDays(today(), 60)}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
              <small className="procurement-hint">
                If nothing changes by {calendarDate(next)}, it returns to Needs
                you.
              </small>
            </label>
          ) : null}
        </fieldset>
        <Footer
          command={command}
          close={close}
          label={response === 'accepted' ? 'Accept change' : 'Record follow-up'}
          pending="Saving…"
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
      title="Purchasing link"
      description="Link this supplier to the same supplier in your purchasing system so Luma can place approved orders and read confirmations and goods receipts."
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
            <p role="status">Loading connections…</p>
          ) : !usable.length ? (
            <Alert tone="info">
              No connection can list suppliers yet. Connect your ERP with
              supplier and purchase-order access in Apps.
            </Alert>
          ) : (
            <>
              <label>
                Purchasing system
                <Select
                  aria-label="Purchasing system"
                  value={selected}
                  options={usable.map((c) => ({ value: c.id, label: c.label }))}
                  onValueChange={(value) => {
                    setConnectionId(value ?? '');
                    setExternalId('');
                  }}
                />
              </label>
              <label>
                Supplier in that system
                <Select
                  aria-label="Supplier in that system"
                  value={externalId}
                  disabled={suppliers.isPending || !!suppliers.error}
                  options={[
                    {
                      value: '',
                      label: suppliers.isPending ? 'Loading…' : 'Not linked',
                    },
                    ...(suppliers.data?.items ?? []).map((s) => ({
                      value: s.externalId,
                      label: [s.name ?? `Supplier ${s.externalId}`, s.number]
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
                  Orders go to {match.email} through your purchasing system’s
                  own workflow.
                </small>
              ) : null}
            </>
          )}
          <label>
            Expect a confirmation within (hours)
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
              After this, an unconfirmed order appears in Needs you.
            </small>
          </label>
        </fieldset>
        <Footer
          command={command}
          close={close}
          label="Save link"
          pending="Saving…"
        />
      </form>
    </Frame>
  );
}
