import type {
  PurchaseOrder,
  PurchaseOrderStatus,
  Supplier,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { type RefObject, useState } from 'react';

import {
  createOrder,
  createSupplier,
  ProcurementError,
  procurementError,
  procurementKey,
  transitionOrder,
} from './data';
import { statusLabels } from './presentation';

/**
 * Runs a procurement command and keeps an uncertain request's body for an exact retry. The
 * form locks while a request is pending or its outcome is unknown.
 */
export function useCommand<T, R>(
  organizationId: string,
  save: (body: T) => Promise<R>,
  saved: (value: R) => void,
) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: (value) => {
      void client.invalidateQueries({
        queryKey: procurementKey(organizationId),
      });
      void client.invalidateQueries({
        queryKey: [
          'private',
          'organization',
          organizationId,
          'purchasing-outcomes',
        ],
      });
      saved(value);
    },
  });
  const uncertain =
    mutation.isError &&
    (!(mutation.error instanceof ProcurementError) ||
      mutation.error.status >= 500);

  return {
    ...mutation,
    uncertain,
    locked: mutation.isPending || uncertain,
    submit: (body: T) =>
      mutation.mutate(uncertain ? mutation.variables! : body),
  };
}

function ExternalFields({
  system,
  externalId,
  setSystem,
  setExternalId,
  disabled,
}: {
  system: string;
  externalId: string;
  setSystem: (v: string) => void;
  setExternalId: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <details className="procurement-external-fields">
      <summary>
        {m.procurement_form_reference_title()}{' '}
        <span>{m.common_optional()}</span>
      </summary>
      <p>{m.procurement_form_reference_description()}</p>
      <div className="procurement-form-pair">
        <label>
          {m.procurement_form_reference_system()}
          <Input
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            maxLength={200}
            required={!!externalId}
            disabled={disabled}
            placeholder={m.procurement_form_reference_system_placeholder()}
          />
        </label>
        <label>
          {m.procurement_form_reference_id()}
          <Input
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            maxLength={200}
            required={!!system}
            disabled={disabled}
            placeholder={m.procurement_form_reference_id_placeholder()}
          />
        </label>
      </div>
    </details>
  );
}

/** Creates a minimal supplier with optional source mapping and safe request retries. */
export function SupplierDialog({
  organizationId,
  close,
  returnFocus,
}: {
  organizationId: string;
  close: () => void;
  returnFocus?: RefObject<HTMLButtonElement | null>;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState('');
  const [system, setSystem] = useState('');
  const [externalId, setExternalId] = useState('');
  const command = useCommand(
    organizationId,
    (body: Parameters<typeof createSupplier>[1]) =>
      createSupplier(organizationId, body),
    close,
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) close();
      }}
    >
      <DialogContent showCloseButton={!command.locked} finalFocus={returnFocus}>
        <DialogTitle>{m.procurement_supplier_dialog_title()}</DialogTitle>
        <DialogDescription>
          {m.procurement_supplier_dialog_description()}
        </DialogDescription>
        <form
          className="procurement-form"
          onSubmit={(e) => {
            e.preventDefault();
            command.submit({
              id,
              name,
              externalReferences: system ? [{ system, externalId }] : [],
            });
          }}
        >
          <fieldset disabled={command.locked}>
            <label>
              {m.procurement_supplier_dialog_name()}
              <Input
                autoFocus
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={m.procurement_supplier_dialog_name_placeholder()}
              />
            </label>
            <ExternalFields
              {...{ system, externalId, setSystem, setExternalId }}
              disabled={command.locked}
            />
          </fieldset>
          {command.error && (
            <Alert tone="danger" role="alert">
              {procurementError(command.error)}
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={command.locked}
              onClick={close}
            >
              {m.common_cancel()}
            </Button>
            <Button type="submit" disabled={command.isPending}>
              {command.isPending
                ? m.common_saving()
                : command.uncertain
                  ? m.procurement_form_retry_save()
                  : m.procurement_supplier_dialog_title()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Collects order lines in a compact form and creates an authoritative Luma draft. */
export function OrderDialog({
  organizationId,
  suppliers,
  close,
  saved,
  returnFocus,
}: {
  organizationId: string;
  suppliers: Supplier[];
  close: () => void;
  saved: (order: PurchaseOrder) => void;
  returnFocus?: RefObject<HTMLButtonElement | null>;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? '');
  const [reference, setReference] = useState('');
  const [system, setSystem] = useState('');
  const [externalId, setExternalId] = useState('');
  const [lines, setLines] = useState(() => [
    {
      id: crypto.randomUUID(),
      sku: '',
      description: '',
      quantity: '1',
      unit: 'each',
    },
  ]);
  const command = useCommand(
    organizationId,
    (body: Parameters<typeof createOrder>[1]) =>
      createOrder(organizationId, body),
    saved,
  );
  const updateLine = (id: string, field: string, value: string) =>
    setLines((previous) =>
      previous.map((line) =>
        line.id === id ? { ...line, [field]: value } : line,
      ),
    );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) close();
      }}
    >
      <DialogContent
        className="procurement-order-dialog"
        showCloseButton={!command.locked}
        finalFocus={returnFocus}
      >
        <DialogTitle>{m.procurement_order_dialog_title()}</DialogTitle>
        <DialogDescription>
          {m.procurement_order_dialog_description()}
        </DialogDescription>
        <form
          className="procurement-form"
          onSubmit={(e) => {
            e.preventDefault();
            command.submit({
              id,
              supplierId,
              reference,
              authority: 'luma',
              externalReferences: system ? [{ system, externalId }] : [],
              lines: lines.map((line) => ({
                ...line,
                quantity: Number(line.quantity),
              })),
            });
          }}
        >
          <fieldset disabled={command.locked}>
            <div className="procurement-form-pair">
              <label>
                {m.procurement_order_dialog_reference()}
                <Input
                  autoFocus
                  required
                  maxLength={200}
                  placeholder={m.procurement_order_dialog_reference_placeholder()}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
              <label>
                {m.procurement_order_dialog_supplier()}
                <Select
                  aria-label={m.procurement_order_dialog_supplier()}
                  value={supplierId}
                  onValueChange={(value) => setSupplierId(value ?? '')}
                  options={suppliers.map((s) => ({
                    value: s.id,
                    label: s.name,
                  }))}
                  disabled={command.locked}
                />
              </label>
            </div>
            <div className="procurement-lines-heading">
              <h3>{m.procurement_order_dialog_lines()}</h3>
              <span>
                {m.procurement_order_dialog_line_count({
                  count: lines.length,
                  max: 100,
                })}
              </span>
            </div>
            <div className="procurement-line-inputs">
              {lines.map((line, index) => (
                <div key={line.id} className="procurement-line-input">
                  <label>
                    {m.procurement_order_dialog_sku_numbered({
                      line: formatNumber(index + 1),
                    })}
                    <Input
                      aria-label={m.procurement_order_dialog_sku_numbered({
                        line: formatNumber(index + 1),
                      })}
                      required
                      maxLength={200}
                      value={line.sku}
                      onChange={(e) =>
                        updateLine(line.id, 'sku', e.target.value)
                      }
                      placeholder={m.procurement_order_dialog_sku()}
                    />
                  </label>
                  <label>
                    {m.procurement_order_dialog_description_field()}
                    <Input
                      aria-label={m.procurement_order_dialog_description_numbered(
                        { line: formatNumber(index + 1) },
                      )}
                      required
                      maxLength={200}
                      value={line.description}
                      onChange={(e) =>
                        updateLine(line.id, 'description', e.target.value)
                      }
                      placeholder={m.procurement_order_dialog_description_placeholder()}
                    />
                  </label>
                  <label>
                    {m.procurement_order_dialog_quantity()}
                    <Input
                      aria-label={m.procurement_order_dialog_quantity_numbered({
                        line: formatNumber(index + 1),
                      })}
                      type="number"
                      min="0.000001"
                      max="1000000000"
                      step="any"
                      required
                      value={line.quantity}
                      onChange={(e) =>
                        updateLine(line.id, 'quantity', e.target.value)
                      }
                    />
                  </label>
                  <label>
                    {m.procurement_order_dialog_unit()}
                    <Input
                      aria-label={m.procurement_order_dialog_unit_numbered({
                        line: formatNumber(index + 1),
                      })}
                      required
                      maxLength={40}
                      value={line.unit}
                      onChange={(e) =>
                        updateLine(line.id, 'unit', e.target.value)
                      }
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={m.procurement_order_dialog_remove_line({
                      line: formatNumber(index + 1),
                    })}
                    disabled={lines.length === 1}
                    onClick={() =>
                      setLines((previous) =>
                        previous.filter((item) => item.id !== line.id),
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              disabled={lines.length >= 100}
              onClick={() =>
                setLines((previous) => [
                  ...previous,
                  {
                    id: crypto.randomUUID(),
                    sku: '',
                    description: '',
                    quantity: '1',
                    unit: 'each',
                  },
                ])
              }
            >
              <Plus size={15} />
              {m.procurement_order_dialog_add_line()}
            </Button>
            <ExternalFields
              {...{ system, externalId, setSystem, setExternalId }}
              disabled={command.locked}
            />
          </fieldset>
          {command.error && (
            <Alert tone="danger" role="alert">
              {procurementError(command.error)}
            </Alert>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={command.locked}
              onClick={close}
            >
              {m.common_cancel()}
            </Button>
            <Button type="submit" disabled={command.isPending || !supplierId}>
              {command.isPending
                ? m.procurement_order_dialog_creating()
                : command.uncertain
                  ? m.procurement_form_retry_save()
                  : m.procurement_order_dialog_create()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Button and dialog wording for each Luma status change. */
export const transitionLabels = {
  draft: m.procurement_transition_open,
  open: m.procurement_transition_open,
  closed: m.procurement_transition_close,
  cancelled: m.procurement_transition_cancel,
} satisfies Record<PurchaseOrderStatus, () => string>;

/** Confirms the next state and records the operator's reason against the reviewed revision. */
export function TransitionDialog({
  organizationId,
  order,
  status,
  close,
}: {
  organizationId: string;
  order: PurchaseOrder;
  status: PurchaseOrderStatus;
  close: () => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState('');
  const command = useCommand(
    organizationId,
    (body: Parameters<typeof transitionOrder>[2]) =>
      transitionOrder(organizationId, order.id, body),
    close,
  );
  const label = transitionLabels[status]();
  const change = {
    order: order.reference,
    from: statusLabels[order.status](),
    to: statusLabels[status](),
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) close();
      }}
    >
      <DialogContent showCloseButton={!command.locked}>
        <DialogTitle>{label}</DialogTitle>
        <DialogDescription>
          {status === 'open'
            ? m.procurement_transition_open_description(change)
            : m.procurement_transition_final_description(change)}
        </DialogDescription>
        <form
          className="procurement-form"
          onSubmit={(e) => {
            e.preventDefault();
            command.submit({
              id,
              expectedRevision: order.revision,
              status,
              reason,
            });
          }}
        >
          <label>
            {m.procurement_transition_reason()}
            <Input
              autoFocus
              required
              maxLength={1000}
              disabled={command.locked}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={m.procurement_transition_reason_placeholder()}
            />
          </label>
          {command.error && (
            <Alert tone="danger" role="alert">
              {procurementError(command.error)}
            </Alert>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={command.locked}
              onClick={close}
            >
              {m.common_back()}
            </Button>
            <Button type="submit" disabled={command.isPending}>
              {command.isPending
                ? m.common_saving()
                : command.uncertain
                  ? m.procurement_form_retry_save()
                  : label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
