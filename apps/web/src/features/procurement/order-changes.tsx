import type {
  PurchaseOrder,
  PurchaseOrderChangeInput,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { privateQueryDefaults } from '../../lib/private-query';
import { EvidenceDisclosure } from '../../shared/evidence/evidence';
import {
  createProcurementClient,
  procurementError,
  procurementKey,
} from './data';
import { useCommand } from './forms';

const api = createProcurementClient().procurementChanges;
const changeLabels = {
  preparing: m.procurement_changes_preparing,
  approval_required: m.procurement_changes_approval,
  approved: m.procurement_changes_approved,
  rejected: m.procurement_changes_rejected,
  submitting: m.procurement_changes_applying,
  uncertain: m.procurement_changes_uncertain,
  verified: m.procurement_changes_verified,
  failed: m.procurement_changes_failed,
  expired: m.procurement_changes_expired,
};

/** Shows source change support, pending approvals and previous order lines with their evidence. */
export function PurchaseOrderChanges({
  organizationId,
  order,
}: {
  organizationId: string;
  order: PurchaseOrder;
}) {
  const query = useQuery({
    queryKey: [...procurementKey(organizationId), 'order-changes', order.id],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.list(
        { params: { organizationId, purchaseOrderId: order.id } },
        { signal },
      ),
  });
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const action = useMutation({
    mutationFn: ({
      id,
      kind,
    }: {
      id: string;
      kind: 'approve' | 'reject' | 'send' | 'check';
    }) =>
      kind === 'approve' || kind === 'reject'
        ? api.decide({
            params: { organizationId, changeId: id },
            body: { outcome: kind === 'approve' ? 'approved' : 'rejected' },
          })
        : api[kind]({ params: { organizationId, changeId: id }, body: {} }),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: procurementKey(organizationId),
      });
    },
  });
  if (query.data?.enabled === false) return null;

  return (
    <Card as="section" className="procurement-section">
      <div className="procurement-section-heading">
        <h2>{m.procurement_changes_title()}</h2>
        {query.data?.canRevise && query.data.canManage ? (
          <Button variant="outline" onClick={() => setEditing(true)}>
            {m.procurement_changes_request()}
          </Button>
        ) : null}
      </div>
      <p className="procurement-note">{m.procurement_changes_note()}</p>
      {query.isPending ? <p role="status">{m.common_loading()}</p> : null}
      {query.error ? (
        <Alert role="alert" tone="danger">
          {m.procurement_changes_unavailable()}
        </Alert>
      ) : null}
      {query.data && !query.data.canRevise ? (
        <p className="procurement-note">{m.procurement_changes_no_support()}</p>
      ) : null}
      {query.data ? (
        <p className="procurement-note">
          {query.data.cancelReasonCode === 'received'
            ? m.procurement_changes_cancel_received()
            : m.procurement_changes_cancel_unsupported()}
        </p>
      ) : null}
      {action.error ? (
        <Alert role="alert" tone="danger">
          {procurementError(action.error)}
        </Alert>
      ) : null}
      {query.data?.changes.map((change) => (
        <section key={change.id}>
          <div className="procurement-section-heading">
            <h3>
              {m.procurement_changes_revision({
                revision: formatNumber(change.proposed.revision),
              })}
            </h3>
            <span>{changeLabels[change.state]()}</span>
          </div>
          <p>{change.request.reason}</p>
          <p className="procurement-note">
            <WorkspaceDate value={change.requestedAt} />
          </p>
          {change.affectsCommitments ? (
            <Alert tone="warning">{m.procurement_changes_commitments()}</Alert>
          ) : null}
          <DataTable
            caption={m.procurement_changes_comparison()}
            density="compact"
            rows={[
              ...new Set([
                ...change.baseline.lines.map((line) => line.id),
                ...change.proposed.lines.map((line) => line.id),
              ]),
            ]}
            rowKey={(id) => id}
            columns={[
              {
                key: 'product',
                header: m.procurement_lines_item(),
                cell: (id) =>
                  change.proposed.lines.find((line) => line.id === id)?.sku ??
                  change.baseline.lines.find((line) => line.id === id)?.sku,
              },
              {
                key: 'before',
                header: m.procurement_changes_before(),
                numeric: true,
                cell: (id) => {
                  const line = change.baseline.lines.find(
                    (line) => line.id === id,
                  );

                  return line
                    ? formatNumber(line.quantity)
                    : m.common_empty_value();
                },
              },
              {
                key: 'after',
                header: m.procurement_changes_after(),
                numeric: true,
                cell: (id) => {
                  const line = change.proposed.lines.find(
                    (line) => line.id === id,
                  );

                  return line
                    ? formatNumber(line.quantity)
                    : m.procurement_changes_removed();
                },
              },
              {
                key: 'date',
                header: m.procurement_changes_date(),
                cell: (id) => {
                  const date = change.proposed.lines.find(
                    (line) => line.id === id,
                  )?.requestedDeliveryDate;

                  return date ? (
                    <WorkspaceDate value={date} precision="day" />
                  ) : (
                    m.common_empty_value()
                  );
                },
              },
            ]}
          />
          {change.state === 'approval_required' &&
          query.data?.canManage &&
          change.canApprove ? (
            <>
              <Button
                disabled={action.isPending}
                onClick={() =>
                  action.mutate({ id: change.id, kind: 'approve' })
                }
              >
                {m.procurement_changes_approve()}
              </Button>
              <Button
                variant="outline"
                disabled={action.isPending}
                onClick={() => action.mutate({ id: change.id, kind: 'reject' })}
              >
                {m.procurement_next_reject()}
              </Button>
            </>
          ) : null}
          {(change.state === 'approved' || change.state === 'preparing') &&
          query.data?.canManage ? (
            <Button
              disabled={action.isPending}
              onClick={() => action.mutate({ id: change.id, kind: 'send' })}
            >
              {m.procurement_changes_send()}
            </Button>
          ) : null}
          {['submitting', 'uncertain'].includes(change.state) &&
          query.data?.canManage ? (
            <Button
              variant="outline"
              disabled={action.isPending}
              onClick={() => action.mutate({ id: change.id, kind: 'check' })}
            >
              {m.procurement_changes_check()}
            </Button>
          ) : null}
          {change.verifiedAt ? (
            <p className="procurement-note">
              {m.procurement_changes_verified()} ·{' '}
              <WorkspaceDate value={change.verifiedAt} />
            </p>
          ) : null}
          {change.observationRefs.length ? (
            <EvidenceDisclosure
              organizationId={organizationId}
              subject={{ kind: 'purchase_order', id: order.id }}
              refs={change.observationRefs}
              count={change.observationRefs.length}
            />
          ) : null}
          {change.failure ? (
            <Alert role="status" tone="warning">
              {change.failure}
            </Alert>
          ) : null}
        </section>
      ))}
      {query.data?.revisions.length ? (
        <details className="procurement-external-fields">
          <summary>{m.procurement_changes_history()}</summary>
          {query.data.revisions.map((revision) => (
            <section key={revision.order.revision}>
              <h3>
                {m.procurement_changes_revision({
                  revision: formatNumber(revision.order.revision),
                })}
              </h3>
              <p>{revision.reason}</p>
              <WorkspaceDate value={revision.recordedAt} />
              <ul>
                {revision.order.lines.map((line) => (
                  <li key={line.id}>
                    {line.sku} · {formatNumber(line.quantity)} {line.unit}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </details>
      ) : null}
      {editing ? (
        <OrderRevisionDialog
          organizationId={organizationId}
          order={order}
          close={() => setEditing(false)}
        />
      ) : null}
    </Card>
  );
}

/** Reviews one provider position at a time; an uncertain request retains its original retry key. */
export function OrderRevisionDialog({
  organizationId,
  order,
  close,
  initialLineId,
  initialQuantity,
}: {
  organizationId: string;
  order: PurchaseOrder;
  close: () => void;
  initialLineId?: string | undefined;
  initialQuantity?: number | undefined;
}) {
  const prefix = useId(),
    [id] = useState(() => crypto.randomUUID()),
    [newLineId] = useState(() => crypto.randomUUID()),
    [baseline] = useState(order);
  const initial = baseline.lines.find(
    (line) => line.id === (initialLineId ?? baseline.lines[0]?.id),
  );
  const command = useCommand(
    organizationId,
    (body: PurchaseOrderChangeInput) =>
      api.propose({
        params: { organizationId, purchaseOrderId: baseline.id },
        body,
      }),
    close,
  );
  const form = useForm({
    defaultValues: {
      kind: 'update_line' as 'update_line' | 'add_line' | 'remove_line',
      lineId: initial?.id ?? '',
      quantity: String(initialQuantity ?? initial?.quantity ?? ''),
      date: initial?.requestedDeliveryDate ?? '',
      sku: '',
      description: '',
      reason: '',
    },
    onSubmit: ({ value }) => {
      const { kind, lineId, quantity, date, sku, description, reason } = value;
      const operation: PurchaseOrderChangeInput['operation'] =
        kind === 'add_line'
          ? {
              kind: 'add_line',
              line: {
                id: newLineId,
                sku,
                description,
                quantity: Number(quantity),
                unit: 'each',
              },
              requestedDeliveryDate: date,
            }
          : kind === 'remove_line'
            ? { kind: 'remove_line', lineId }
            : {
                kind: 'update_line',
                lineId,
                ...(quantity ? { quantity: Number(quantity) } : {}),
                ...(date ? { requestedDeliveryDate: date } : {}),
              };
      command.submit({
        id,
        expectedRevision: baseline.revision,
        reason,
        operation,
      });
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) close();
      }}
    >
      <DialogContent>
        <DialogTitle>{m.procurement_changes_request()}</DialogTitle>
        <DialogDescription>
          {m.procurement_changes_form_note()}
        </DialogDescription>
        <form
          className="procurement-form"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Subscribe selector={(state) => state.values}>
            {({ kind, lineId, quantity, date, sku, description, reason }) => (
              <>
                <Field>
                  <FieldLabel htmlFor={`${prefix}-kind`}>
                    {m.procurement_changes_operation()}
                  </FieldLabel>
                  <Select
                    id={`${prefix}-kind`}
                    value={kind}
                    onValueChange={(value) =>
                      form.setFieldValue('kind', value ?? 'update_line')
                    }
                    options={[
                      {
                        value: 'update_line',
                        label: m.procurement_changes_update_line(),
                      },
                      {
                        value: 'add_line',
                        label: m.procurement_changes_add_line(),
                      },
                      {
                        value: 'remove_line',
                        label: m.procurement_changes_remove_line(),
                      },
                    ]}
                    disabled={command.locked}
                  />
                </Field>
                {kind !== 'add_line' ? (
                  <Field>
                    <FieldLabel htmlFor={`${prefix}-line`}>
                      {m.procurement_changes_line()}
                    </FieldLabel>
                    <Select
                      id={`${prefix}-line`}
                      value={lineId}
                      onValueChange={(value) => {
                        const selected = baseline.lines.find(
                          (line) => line.id === value,
                        );
                        form.setFieldValue('lineId', value ?? '');
                        form.setFieldValue(
                          'quantity',
                          String(selected?.quantity ?? ''),
                        );
                        form.setFieldValue(
                          'date',
                          selected?.requestedDeliveryDate ?? '',
                        );
                      }}
                      options={baseline.lines.map((line) => ({
                        value: line.id,
                        label: line.sku,
                      }))}
                      disabled={command.locked}
                    />
                  </Field>
                ) : (
                  <>
                    <Field>
                      <FieldLabel htmlFor={`${prefix}-sku`}>
                        {m.procurement_order_dialog_sku()}
                      </FieldLabel>
                      <Input
                        id={`${prefix}-sku`}
                        value={sku}
                        onChange={(e) =>
                          form.setFieldValue('sku', e.target.value)
                        }
                        required
                        disabled={command.locked}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${prefix}-description`}>
                        {m.procurement_order_dialog_description_field()}
                      </FieldLabel>
                      <Input
                        id={`${prefix}-description`}
                        value={description}
                        onChange={(e) =>
                          form.setFieldValue('description', e.target.value)
                        }
                        required
                        disabled={command.locked}
                      />
                    </Field>
                  </>
                )}
                {kind !== 'remove_line' ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor={`${prefix}-quantity`}>
                        {m.procurement_order_dialog_quantity()}
                      </FieldLabel>
                      <Input
                        id={`${prefix}-quantity`}
                        type="number"
                        min="0.000001"
                        step="any"
                        value={quantity}
                        onChange={(e) =>
                          form.setFieldValue('quantity', e.target.value)
                        }
                        required
                        disabled={command.locked}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${prefix}-date`}>
                        {m.procurement_changes_date()}
                      </FieldLabel>
                      <Input
                        id={`${prefix}-date`}
                        type="date"
                        value={date}
                        onChange={(e) =>
                          form.setFieldValue('date', e.target.value)
                        }
                        required={kind === 'add_line'}
                        disabled={command.locked}
                      />
                    </Field>
                  </>
                ) : null}
                <Field>
                  <FieldLabel htmlFor={`${prefix}-reason`}>
                    {m.procurement_changes_reason()}
                  </FieldLabel>
                  <Input
                    id={`${prefix}-reason`}
                    value={reason}
                    onChange={(e) =>
                      form.setFieldValue('reason', e.target.value)
                    }
                    maxLength={1000}
                    required
                    disabled={command.locked}
                  />
                </Field>
                {command.error ? (
                  <Alert role="alert" tone="danger">
                    {procurementError(command.error)}
                  </Alert>
                ) : null}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={close}
                    disabled={command.isPending}
                  >
                    {m.common_cancel()}
                  </Button>
                  <Button type="submit" disabled={command.isPending}>
                    {command.uncertain
                      ? m.common_retry()
                      : m.procurement_changes_request()}
                  </Button>
                </DialogFooter>
              </>
            )}
          </form.Subscribe>
        </form>
      </DialogContent>
    </Dialog>
  );
}
