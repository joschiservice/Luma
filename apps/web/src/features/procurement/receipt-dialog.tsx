import type { PurchaseOrderRecord } from '@luma/api-contract';
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
import { useState } from 'react';

import { procurementError, recordReceipt } from './data';
import { useCommand } from './forms';
import { commitmentKinds } from './presentation';

/** Records a cumulative receipt and its damaged units atomically, or a sourced difference. */
export function ReceiptDialog({
  organizationId,
  record,
  close,
}: {
  organizationId: string;
  record: PurchaseOrderRecord;
  close: () => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [lineId, setLineId] = useState(record.order.lines[0]!.id);
  const [kind, setKind] = useState<'received' | 'shortage' | 'damaged'>(
    record.reconciliation.manualReceipt ? 'received' : 'shortage',
  );
  const [amount, setAmount] = useState('');
  const [damage, setDamage] = useState('0');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [receivedAt, setReceivedAt] = useState(() => {
    const now = new Date();

    return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  });
  const command = useCommand(
    organizationId,
    (body: Parameters<typeof recordReceipt>[2]) =>
      recordReceipt(organizationId, record.order.id, body),
    close,
  );
  const latest = (value: 'received' | 'shortage' | 'damaged') =>
    record.commitments
      .filter(
        (c) =>
          c.lineId === lineId && c.kind === value && c.status === 'confirmed',
      )
      .at(-1)?.id ?? null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) close();
      }}
    >
      <DialogContent showCloseButton={!command.locked}>
        <DialogTitle>{m.procurement_receipt_title()}</DialogTitle>
        <DialogDescription>
          {m.procurement_receipt_description()}
        </DialogDescription>
        <form
          className="procurement-form"
          onSubmit={(event) => {
            event.preventDefault();
            command.submit({
              id,
              lineId,
              kind,
              quantity: Number(amount),
              expectedCommitmentId: latest(kind),
              ...(kind === 'received'
                ? {
                    damagedQuantity: Number(damage),
                    expectedDamagedCommitmentId: latest('damaged'),
                  }
                : {}),
              receivedAt: new Date(receivedAt).toISOString(),
              condition:
                Number(damage) > 0 || kind === 'damaged' ? 'mixed' : 'good',
              reason,
              evidence: evidence
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            });
          }}
        >
          <fieldset disabled={command.locked}>
            <label>
              {m.procurement_lines_item()}
              <Select
                value={lineId}
                onValueChange={(value) => {
                  if (value) setLineId(value);
                }}
                options={record.order.lines.map((line) => ({
                  value: line.id,
                  label: `${line.description} · ${line.sku}`,
                }))}
              />
            </label>
            <label>
              {m.procurement_receipt_kind()}
              <Select
                value={kind}
                onValueChange={(value) => {
                  if (
                    value === 'received' ||
                    value === 'shortage' ||
                    value === 'damaged'
                  )
                    setKind(value);
                }}
                options={(['received', 'shortage', 'damaged'] as const)
                  .filter(
                    (value) =>
                      value !== 'received' ||
                      record.reconciliation.manualReceipt,
                  )
                  .map((value) => ({ value, label: commitmentKinds[value]() }))}
              />
            </label>
            <label>
              {m.procurement_receipt_quantity()}
              <Input
                autoFocus
                type="number"
                min="0"
                max="1000000000"
                step="any"
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            {kind === 'received' ? (
              <label>
                {m.procurement_receipt_damage()}
                <Input
                  type="number"
                  min="0"
                  max={amount || undefined}
                  step="any"
                  required
                  value={damage}
                  onChange={(event) => setDamage(event.target.value)}
                />
                <small>{m.procurement_receipt_damage_hint()}</small>
              </label>
            ) : null}
            <label>
              {m.procurement_receipt_time()}
              <Input
                type="datetime-local"
                required
                value={receivedAt}
                onChange={(event) => setReceivedAt(event.target.value)}
              />
            </label>
            <label>
              {m.procurement_respond_note()}
              <Textarea
                required
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label>
              {m.procurement_receipt_evidence()}
              <Textarea
                required
                maxLength={2000}
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
              />
              <small>{m.procurement_receipt_evidence_hint()}</small>
            </label>
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
                  : m.common_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
