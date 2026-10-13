import type {
  PurchaseOrderRecord,
  SupplierEmailStatus,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import {
  outboundStateLabels,
  outboundStates,
} from '../../shared/messaging/outbound-state';
import { procurementError } from './data';
import { useCommand } from './forms';
import {
  downloadSupplierOrder,
  draftSupplierFollowUp,
  draftSupplierOrder,
  supplierEmailOptions,
} from './supplier-email-data';

/** Keeps supplier mail review and approval in the Operations Inbox, alongside the order's evidence. */
export function SupplierEmailPanel({
  organizationId,
  record,
}: {
  organizationId: string;
  record: PurchaseOrderRecord;
}) {
  const query = useQuery(supplierEmailOptions(organizationId, record.order.id));
  const [draft, setDraft] = useState<{
    kind: 'submission' | 'follow_up';
    attentionKey?: string;
  } | null>(null);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  if (query.isPending)
    return (
      <p className="procurement-muted" role="status">
        {m.procurement_email_loading()}
      </p>
    );
  if (query.isError && !query.data)
    return <Alert tone="neutral">{m.procurement_email_unavailable()}</Alert>;
  const data = query.data;
  if (
    !data ||
    (!data.submissionAvailable && !data.followUpAvailable && !data.items.length)
  )
    return null;
  const overdue = (
    record.submission?.channel === 'email' &&
    record.submission.state === 'failed'
      ? []
      : record.progress.attention
  ).filter((item) =>
    ['confirmation_overdue', 'delivery_overdue'].includes(item.kind),
  );
  const activeSubmission = data.items.some(
    (item) =>
      item.work.kind === 'submission' &&
      !['failed', 'discarded', 'rejected', 'expired', 'withheld'].includes(
        item.outbound.state,
      ),
  );

  return (
    <Card className="procurement-section">
      <h3>{m.procurement_email_title()}</h3>
      <p className="procurement-muted">{m.procurement_email_description()}</p>
      {!data.mailboxes.length ? (
        <Alert tone="neutral">{m.procurement_email_connect()}</Alert>
      ) : null}
      {downloadError ? (
        <Alert tone="danger" role="alert">
          {procurementError(downloadError)}
        </Alert>
      ) : null}
      <div className="procurement-actions">
        {record.canManage &&
        data.canCompose &&
        data.submissionAvailable &&
        !record.supplier?.link &&
        record.order.authority === 'luma' &&
        ['draft', 'open'].includes(record.order.status) &&
        !activeSubmission ? (
          <Button
            variant="outline"
            disabled={!data.mailboxes.length}
            onClick={() => setDraft({ kind: 'submission' })}
          >
            {m.procurement_email_draft_order()}
          </Button>
        ) : null}
        {record.canManage && data.canCompose && data.followUpAvailable
          ? overdue.map((item) => (
              <Button
                key={item.key}
                variant="outline"
                disabled={!data.mailboxes.length}
                onClick={() =>
                  setDraft({ kind: 'follow_up', attentionKey: item.key })
                }
              >
                {m.procurement_email_follow_up()}
              </Button>
            ))
          : null}
      </div>
      {data.items.length ? (
        <ul className="procurement-side-list">
          {data.items.map((item) => (
            <li key={item.outbound.id}>
              <div>
                <strong>{item.outbound.subject}</strong>
                <StatePill state={outboundStates[item.outbound.state]}>
                  {outboundStateLabels[item.outbound.state]()}
                </StatePill>
                <p className="procurement-muted">
                  {item.outbound.state === 'sent'
                    ? m.procurement_email_sent()
                    : item.outbound.state === 'failed'
                      ? m.procurement_email_failed()
                      : m.procurement_email_review()}
                </p>
                {item.outbound.stateReason ? (
                  <p>{item.outbound.stateReason}</p>
                ) : null}
              </div>
              <div className="procurement-actions">
                {item.outbound.attachments?.length ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDownloadError(null);
                      void downloadSupplierOrder(
                        organizationId,
                        record.order.id,
                        item.outbound.id,
                      ).catch(setDownloadError);
                    }}
                  >
                    {m.procurement_email_pdf()}
                  </Button>
                ) : null}
                <Link
                  to="/app/$organizationId/inbox"
                  params={{ organizationId }}
                  search={{ thread: item.outbound.threadId, view: 'all' }}
                >
                  {m.procurement_email_open_inbox()}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="procurement-muted">{m.procurement_email_empty()}</p>
      )}
      {draft ? (
        <SupplierEmailDialog
          organizationId={organizationId}
          record={record}
          mailboxes={data.mailboxes}
          kind={draft.kind}
          attentionKey={draft.attentionKey}
          close={() => setDraft(null)}
        />
      ) : null}
    </Card>
  );
}

function SupplierEmailDialog({
  organizationId,
  record,
  mailboxes,
  kind,
  attentionKey,
  close,
}: {
  organizationId: string;
  record: PurchaseOrderRecord;
  mailboxes: SupplierEmailStatus['mailboxes'];
  kind: 'submission' | 'follow_up';
  attentionKey: string | undefined;
  close: () => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [connectionId, setConnectionId] = useState(
    mailboxes[0]?.connectionId ?? '',
  );
  const [companyName, setCompanyName] = useState('');
  const [address, setAddress] = useState('');
  const [registration, setRegistration] = useState('');
  const [delivery, setDelivery] = useState('');
  const [reason, setReason] = useState('');
  const [nextCheck, setNextCheck] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const command = useCommand<null, string>(
    organizationId,
    async () => {
      const result =
        kind === 'submission'
          ? await draftSupplierOrder(organizationId, record.order.id, {
              id,
              connectionId,
              requestedDeliveryDate: delivery,
              company: {
                name: companyName,
                address,
                registration: registration || null,
              },
            })
          : await draftSupplierFollowUp(organizationId, record.order.id, {
              id,
              connectionId,
              attentionKey: attentionKey!,
              nextCheckAt: new Date(nextCheck).toISOString(),
              reason,
            });

      return result.threadId;
    },
    setCreated,
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) close();
      }}
    >
      <DialogContent showCloseButton={!command.locked}>
        <DialogTitle>
          {kind === 'submission'
            ? m.procurement_email_draft_order()
            : m.procurement_email_follow_up()}
        </DialogTitle>
        <DialogDescription>
          {m.procurement_email_draft_hint()}
        </DialogDescription>
        {created ? (
          <>
            <p role="status">{m.procurement_email_drafted()}</p>
            <Link
              to="/app/$organizationId/inbox"
              params={{ organizationId }}
              search={{ thread: created, view: 'all' }}
            >
              {m.procurement_email_open_inbox()}
            </Link>
            <DialogFooter>
              <Button onClick={close}>{m.common_close()}</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="procurement-form"
            onSubmit={(event) => {
              event.preventDefault();
              command.submit(null);
            }}
          >
            <fieldset disabled={command.locked}>
              <label>
                {m.procurement_email_sender()}
                <Select
                  value={connectionId}
                  onValueChange={(value) => {
                    if (value) setConnectionId(value);
                  }}
                  options={mailboxes.map((mailbox) => ({
                    value: mailbox.connectionId,
                    label: mailbox.address ?? mailbox.label,
                  }))}
                />
              </label>
              {kind === 'submission' ? (
                <>
                  <label>
                    {m.procurement_email_company()}
                    <Input
                      required
                      autoFocus
                      maxLength={200}
                      value={companyName}
                      onChange={(event) => setCompanyName(event.target.value)}
                    />
                  </label>
                  <label>
                    {m.procurement_email_address()}
                    <Textarea
                      required
                      maxLength={2000}
                      value={address}
                      onChange={(event) => setAddress(event.target.value)}
                    />
                  </label>
                  <label>
                    {m.procurement_email_registration()}
                    <Input
                      maxLength={500}
                      value={registration}
                      onChange={(event) => setRegistration(event.target.value)}
                    />
                  </label>
                  <label>
                    {m.procurement_email_delivery()}
                    <Input
                      required
                      type="date"
                      value={delivery}
                      onChange={(event) => setDelivery(event.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    {m.procurement_email_next_check()}
                    <Input
                      required
                      autoFocus
                      type="datetime-local"
                      value={nextCheck}
                      onChange={(event) => setNextCheck(event.target.value)}
                    />
                  </label>
                  <label>
                    {m.procurement_respond_note()}
                    <Textarea
                      required
                      maxLength={2000}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                </>
              )}
            </fieldset>
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
              <Button type="submit" disabled={command.isPending}>
                {command.isPending
                  ? m.common_saving()
                  : command.uncertain
                    ? m.common_retry()
                    : m.procurement_email_create_draft()}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
