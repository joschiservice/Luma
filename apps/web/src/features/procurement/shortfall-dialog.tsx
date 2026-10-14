import type {
  Attention,
  PurchaseOrderContext,
  PurchaseOrderRecord,
  PurchasingPlan,
  PurchasingPlanInput,
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
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { procurementError } from './data';
import { useCommand } from './forms';
import { proposePurchasingPlan, purchasingOptions } from './purchasing-data';
import { purchasingMissingLabel } from './purchasing-inputs';

/** Reviews an alternative supplier and submits the exact remainder through governed draft admission. */
export function ShortfallDialog({
  organizationId,
  record,
  context,
  attention,
  close,
}: {
  organizationId: string;
  record: PurchaseOrderRecord;
  context?: PurchaseOrderContext | undefined;
  attention: Attention;
  close: () => void;
}) {
  const query = useQuery(purchasingOptions(organizationId));
  const [id] = useState(() => crypto.randomUUID());
  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [reference, setReference] = useState(`${record.order.reference}-R`);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<PurchasingPlan | null>(null);
  const line = record.progress.lines.find(
    (value) => value.lineId === attention.lineId,
  );
  const fact = record.commitments.find(
    (value) => value.id === attention.commitmentId,
  );
  const skuId = context?.lines.find(
    (value) => value.lineId === attention.lineId,
  )?.skuId;
  const remainder =
    fact?.kind === 'confirmed_quantity' && line
      ? Math.max(0, line.ordered - (fact.quantity ?? line.ordered))
      : fact?.kind === 'shortage' || fact?.kind === 'damaged'
        ? (fact.quantity ?? 0)
        : (line?.outstanding ?? 0);
  const candidates =
    query.data?.items.filter(
      (value) =>
        value.skuId === skuId && value.supplierId !== record.order.supplierId,
    ) ?? [];
  const selected = candidates.find((value) => value.supplierId === supplierId);
  const chosenQuantity =
    selected?.packSize && selected.minimumQuantity !== null
      ? Math.ceil(
          Math.max(remainder, selected.minimumQuantity) / selected.packSize,
        ) * selected.packSize
      : null;
  const daily = selected?.demand.daily ?? null;
  const stock = selected?.stocks.find(
    (value) => value.locationId === locationId,
  );
  const cover =
    daily !== null &&
    daily > 0 &&
    stock?.available !== null &&
    stock?.available !== undefined
      ? (stock.available + (chosenQuantity ?? remainder)) / daily
      : null;
  const command = useCommand(
    organizationId,
    (body: PurchasingPlanInput) => proposePurchasingPlan(organizationId, body),
    setResult,
  );
  const missing =
    selected?.missing.filter(
      (key) => !['open_order', 'demand_incomplete', 'lead_time'].includes(key),
    ) ?? [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) close();
      }}
    >
      <DialogContent showCloseButton={!command.locked}>
        <DialogTitle>{m.procurement_shortfall_title()}</DialogTitle>
        <DialogDescription>{attention.summary}</DialogDescription>
        {query.isPending ? (
          <p role="status">{m.purchasing_loading()}</p>
        ) : query.error ? (
          <Alert tone="danger">
            {procurementError(query.error)}
            <Button variant="outline" onClick={() => void query.refetch()}>
              {m.common_retry()}
            </Button>
          </Alert>
        ) : !query.data?.plansEnabled || !record.reconciliation.decisions ? (
          <Alert tone="warning">{m.purchasing_unavailable()}</Alert>
        ) : result ? (
          <>
            <Alert>{m.procurement_shortfall_proposed()}</Alert>
            <p>{result.failure}</p>
            <Link
              to="/app/$organizationId/procurement"
              params={{ organizationId }}
              search={{
                tab: 'purchasing',
                demandPeriodDays: query.data.settings.demandPeriodDays,
              }}
            >
              {m.purchasing_plans_title()}
            </Link>
            <Button variant="outline" onClick={close}>
              {m.common_close()}
            </Button>
          </>
        ) : (
          <form
            className="procurement-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (selected && skuId && locationId && chosenQuantity !== null)
                command.submit({
                  id,
                  supplierId,
                  reference,
                  reason,
                  sourceOrderId: record.order.id,
                  attentionKey: attention.key,
                  lines: [
                    {
                      skuId,
                      locationId,
                      quantity: chosenQuantity,
                      termsRevision: selected.termsRevision,
                    },
                  ],
                });
            }}
          >
            <fieldset disabled={command.locked}>
              {!candidates.length || remainder <= 0 ? (
                <Alert tone="warning">
                  {m.procurement_shortfall_no_supplier()}
                </Alert>
              ) : null}
              <label>
                {m.procurement_column_supplier()}
                <Select
                  value={supplierId}
                  onValueChange={(value) => {
                    setSupplierId(value ?? '');
                    setLocationId('');
                  }}
                  options={candidates.map((value) => ({
                    value: value.supplierId,
                    label: value.supplierName,
                  }))}
                />
              </label>
              <label>
                {m.purchasing_destination()}
                <Select
                  value={locationId}
                  onValueChange={(value) => setLocationId(value ?? '')}
                  options={
                    selected?.stocks.map((value) => ({
                      value: value.locationId,
                      label: value.location,
                    })) ?? []
                  }
                />
              </label>
              <p>
                {m.procurement_shortfall_quantity({
                  quantity: formatNumber(remainder, {
                    maximumFractionDigits: 6,
                  }),
                })}
              </p>
              <p>
                {m.procurement_shortfall_rounding({
                  quantity:
                    chosenQuantity === null
                      ? m.common_unknown()
                      : formatNumber(chosenQuantity, {
                          maximumFractionDigits: 6,
                        }),
                  pack:
                    selected?.packSize === null ||
                    selected?.packSize === undefined
                      ? m.common_unknown()
                      : formatNumber(selected.packSize),
                  minimum:
                    selected?.minimumQuantity === null ||
                    selected?.minimumQuantity === undefined
                      ? m.common_unknown()
                      : formatNumber(selected.minimumQuantity),
                })}
              </p>
              <p>
                {cover === null
                  ? m.procurement_shortfall_cover_unknown()
                  : m.procurement_shortfall_cover({
                      days: formatNumber(cover, { maximumFractionDigits: 1 }),
                    })}
              </p>
              <p>{m.procurement_shortfall_customer_unknown()}</p>
              {missing.length ? (
                <Alert tone="warning">
                  {m.purchasing_inputs_missing()}:{' '}
                  {missing.map(purchasingMissingLabel).join(', ')}
                </Alert>
              ) : null}
              <label>
                {m.purchasing_reference()}
                <Input
                  required
                  maxLength={200}
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
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
              <Button
                type="submit"
                disabled={
                  command.isPending ||
                  !selected ||
                  !locationId ||
                  remainder <= 0 ||
                  chosenQuantity === null ||
                  missing.length > 0
                }
              >
                {command.uncertain
                  ? m.common_retry()
                  : m.procurement_shortfall_propose()}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
