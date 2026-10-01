import type {
  PurchaseOrder,
  PurchaseOrderStatus,
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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

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
        External reference <span>Optional</span>
      </summary>
      <p>Link the same record in another system.</p>
      <div className="procurement-form-pair">
        <label>
          System
          <Input
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            maxLength={200}
            required={!!externalId}
            disabled={disabled}
            placeholder="e.g. JTL"
          />
        </label>
        <label>
          External ID
          <Input
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            maxLength={200}
            required={!!system}
            disabled={disabled}
            placeholder="Record ID"
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
}: {
  organizationId: string;
  close: () => void;
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
      <DialogContent showCloseButton={!command.locked}>
        <DialogTitle>Add supplier</DialogTitle>
        <DialogDescription>
          Keep supplier records and their external references together.
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
              Supplier name
              <Input
                autoFocus
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Northstar Supply"
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
              Cancel
            </Button>
            <Button type="submit" disabled={command.isPending}>
              {command.isPending
                ? 'Saving…'
                : command.uncertain
                  ? 'Retry save'
                  : 'Add supplier'}
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
}: {
  organizationId: string;
  suppliers: Supplier[];
  close: () => void;
  saved: (order: PurchaseOrder) => void;
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
      >
        <DialogTitle>New purchase order</DialogTitle>
        <DialogDescription>
          Create a Luma-owned draft. Review its details before opening it.
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
                Order reference
                <Input
                  autoFocus
                  required
                  maxLength={200}
                  placeholder="e.g. PO-2026-001"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
              <label>
                Supplier
                <Select
                  aria-label="Supplier"
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
              <h3>Order lines</h3>
              <span>{lines.length} / 100</span>
            </div>
            <div className="procurement-line-inputs">
              {lines.map((line, index) => (
                <div key={line.id} className="procurement-line-input">
                  <label>
                    SKU {index + 1}
                    <Input
                      aria-label={`SKU ${index + 1}`}
                      required
                      maxLength={200}
                      value={line.sku}
                      onChange={(e) =>
                        updateLine(line.id, 'sku', e.target.value)
                      }
                      placeholder="SKU"
                    />
                  </label>
                  <label>
                    Description
                    <Input
                      aria-label={`Description ${index + 1}`}
                      required
                      maxLength={200}
                      value={line.description}
                      onChange={(e) =>
                        updateLine(line.id, 'description', e.target.value)
                      }
                      placeholder="Item name"
                    />
                  </label>
                  <label>
                    Quantity
                    <Input
                      aria-label={`Quantity ${index + 1}`}
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
                    Unit
                    <Input
                      aria-label={`Unit ${index + 1}`}
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
                    aria-label={`Remove line ${index + 1}`}
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
              Add line
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
              Cancel
            </Button>
            <Button type="submit" disabled={command.isPending || !supplierId}>
              {command.isPending
                ? 'Creating…'
                : command.uncertain
                  ? 'Retry save'
                  : 'Create draft'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
  const label =
    status === 'open'
      ? 'Open order'
      : status === 'closed'
        ? 'Close order'
        : 'Cancel order';

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
          {order.reference} · {statusLabels[order.status]} →{' '}
          {statusLabels[status]}.{' '}
          {status === 'open'
            ? 'This records the order as open. It does not send it to the supplier.'
            : 'This is a final status. The order and its history stay available.'}
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
            Reason
            <Input
              autoFocus
              required
              maxLength={1000}
              disabled={command.locked}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is the status changing?"
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
              Back
            </Button>
            <Button type="submit" disabled={command.isPending}>
              {command.isPending
                ? 'Saving…'
                : command.uncertain
                  ? 'Retry save'
                  : label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
