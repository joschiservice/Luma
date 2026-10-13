import type {
  PurchasingOverview,
  PurchasingPlan,
  PurchasingPlanInput,
  PurchasingRecommendation,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { privateQueryDefaults } from '../../lib/private-query';
import {
  createProcurementClient,
  procurementError,
  procurementKey,
} from './data';
import { useCommand } from './forms';
import {
  checkPurchasingPlan,
  decidePurchasingPlan,
  executePurchasingPlan,
  ignorePurchasingRecommendation,
  proposePurchasingPlan,
  purchasingOptions,
  purchasingPlansOptions,
  savePurchasingSettings,
} from './purchasing-data';
import { purchasingMissingLabel } from './purchasing-inputs';

const api = createProcurementClient().procurement;

const priceUnits = (amount: string) => {
  const [whole, fraction = ''] = amount.split('.');

  return BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
};

const value = (number: number | null) =>
  number === null
    ? m.common_empty_value()
    : formatNumber(number, { maximumFractionDigits: 2 });

/** Shows every input and keeps independent supplier approvals visible beside the plan. */
export function PurchasingWorkbench({
  organizationId,
  period,
  onPeriod,
  search,
}: {
  organizationId: string;
  period: number;
  onPeriod: (period: number) => void;
  search: string;
}) {
  const query = useQuery(purchasingOptions(organizationId, period));
  const plans = useQuery(purchasingPlansOptions(organizationId));
  const outcomes = useQuery({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'purchasing-outcomes',
    ],
    ...privateQueryDefaults,
    enabled: !!query.data?.canManage,
    queryFn: ({ signal }) =>
      api.purchasingOutcomes({ params: { organizationId } }, { signal }),
  });
  if (query.isPending) return <p role="status">{m.purchasing_loading()}</p>;
  if (query.error)
    return (
      <Alert tone="danger" role="alert">
        {procurementError(query.error)}
        <Button variant="outline" onClick={() => void query.refetch()}>
          {m.common_retry()}
        </Button>
      </Alert>
    );
  if (!query.data.enabled)
    return (
      <Empty>
        <h3>{m.purchasing_unavailable()}</h3>
      </Empty>
    );
  const groups = new Map<string, PurchasingRecommendation[]>();
  for (const row of query.data.items)
    groups.set(row.supplierId, [...(groups.get(row.supplierId) ?? []), row]);
  const term = search.trim().toLowerCase();
  const matchingGroups = new Set(
    [...groups]
      .filter(
        ([supplierId, rows]) =>
          !term ||
          rows.some((row) =>
            [
              row.supplierName,
              row.sku,
              ...row.stocks.map((stock) => stock.sku),
              ...row.existingOrders.map((order) => order.reference),
            ].some((text) => text.toLowerCase().includes(term)),
          ) ||
          plans.data?.items.some(
            (plan) =>
              plan.order.supplierId === supplierId &&
              plan.order.reference.toLowerCase().includes(term),
          ),
      )
      .map(([supplierId]) => supplierId),
  );

  return (
    <div className="purchasing-workbench">
      <div className="purchasing-assumptions">
        <Select
          aria-label={m.purchasing_demand_period()}
          value={String(period)}
          options={[7, 30, 60, 90, 180].map((p) => ({
            value: String(p),
            label: m.purchasing_period_days({ days: p }),
          }))}
          onValueChange={(v) => {
            if (v) onPeriod(Number(v));
          }}
        />
        <span>
          {m.purchasing_safety_days({ days: query.data.settings.safetyDays })}
        </span>
        <WorkspaceDate value={query.data.asOf} />
        {query.data.canManage ? (
          <PurchasingSettingsForm
            organizationId={organizationId}
            overview={query.data}
          />
        ) : null}
      </div>
      {query.data.truncated ? (
        <Alert tone="warning">{m.purchasing_truncated()}</Alert>
      ) : null}
      {!groups.size ? (
        <Empty>
          <h3>{m.purchasing_empty_title()}</h3>
          <p>{m.purchasing_empty_body()}</p>
        </Empty>
      ) : null}
      {groups.size && !matchingGroups.size ? (
        <Empty>
          <h3>{m.purchasing_search_empty_title()}</h3>
          <p>{m.purchasing_search_empty_body()}</p>
        </Empty>
      ) : null}
      {[...groups].map(([supplierId, rows]) => (
        <section
          className="purchasing-supplier-group"
          key={supplierId}
          hidden={!matchingGroups.has(supplierId)}
          aria-label={rows[0]!.supplierName}
        >
          <SupplierPlan
            organizationId={organizationId}
            rows={rows}
            canManage={query.data.canManage && query.data.plansEnabled}
            canIgnore={query.data.canManage && !!outcomes.data?.enabled}
          />
        </section>
      ))}
      {plans.error ? (
        <Alert tone="warning">{procurementError(plans.error)}</Alert>
      ) : null}
      {plans.data?.items.length ? (
        <Card>
          <CardHeader>
            <CardTitle>{m.purchasing_plans_title()}</CardTitle>
          </CardHeader>
          <CardContent>
            {plans.data.items.map((plan) => (
              <PlanResult
                key={plan.id}
                plan={plan}
                organizationId={organizationId}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function PurchasingSettingsForm({
  organizationId,
  overview,
}: {
  organizationId: string;
  overview: PurchasingOverview;
}) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: savePurchasingSettings.bind(null, organizationId),
    onSuccess: () =>
      void client.invalidateQueries({
        queryKey: procurementKey(organizationId),
      }),
  });
  const form = useForm({
    defaultValues: {
      safetyDays: overview.settings.safetyDays,
      locationIds: overview.settings.locationIds,
    },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync({ ...overview.settings, ...value });
    },
  });

  return (
    <Disclosure>
      <summary>{m.purchasing_settings()}</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="safetyDays">
          {(field) => (
            <label>
              {m.purchasing_safety_label()}
              <Input
                type="number"
                min="0"
                max="90"
                value={field.state.value}
                onChange={(e) => field.handleChange(Number(e.target.value))}
              />
            </label>
          )}
        </form.Field>
        <form.Field name="locationIds">
          {(field) => (
            <div>
              {overview.locations.map((l) => (
                <label key={l.id}>
                  <input
                    type="checkbox"
                    checked={field.state.value.includes(l.id)}
                    onChange={(e) =>
                      field.handleChange(
                        e.target.checked
                          ? [...field.state.value, l.id]
                          : field.state.value.filter((id) => id !== l.id),
                      )
                    }
                  />
                  {l.name}
                </label>
              ))}
              <p>{m.purchasing_all_locations()}</p>
            </div>
          )}
        </form.Field>
        {mutation.error ? (
          <Alert tone="danger">{procurementError(mutation.error)}</Alert>
        ) : null}
        <Button disabled={mutation.isPending} type="submit">
          {m.common_save()}
        </Button>
      </form>
    </Disclosure>
  );
}

function SupplierPlan({
  organizationId,
  rows,
  canManage,
  canIgnore,
}: {
  organizationId: string;
  rows: PurchasingRecommendation[];
  canManage: boolean;
  canIgnore: boolean;
}) {
  const [selected, setSelected] = useState<
    Record<string, { quantity: number; locationId: string }>
  >({});
  const [result, setResult] = useState<PurchasingPlan | null>(null);
  const command = useCommand(
    organizationId,
    (body: PurchasingPlanInput) => proposePurchasingPlan(organizationId, body),
    setResult,
  );
  const form = useForm({
    defaultValues: { reason: '', reference: '' },
    onSubmit: async ({ value }) => {
      const first = rows[0]!;
      command.submit({
        id: crypto.randomUUID(),
        supplierId: first.supplierId,
        reference:
          value.reference.trim() ||
          `PO-${new Date().toISOString().slice(0, 10)}-${first.supplierId.slice(0, 6)}`,
        reason: value.reason,
        lines: rows.flatMap((row) =>
          selected[row.key]
            ? [
                {
                  skuId: row.skuId,
                  ...selected[row.key]!,
                  termsRevision: row.termsRevision,
                },
              ]
            : [],
        ),
      });
    },
  });
  const renderReviewChoice = (r: PurchasingRecommendation) =>
    canManage &&
    r.quantity !== null &&
    r.quantity > 0 &&
    !r.missing.length &&
    !r.existingOrders.length ? (
      <div className="purchasing-line-choice">
        <label>
          <input
            type="checkbox"
            aria-label={m.purchasing_select_product({ sku: r.sku })}
            checked={!!selected[r.key]}
            disabled={command.locked}
            onChange={(e) =>
              setSelected((prev) => {
                const next = { ...prev };
                if (e.target.checked)
                  next[r.key] = {
                    quantity: r.quantity!,
                    locationId: r.stocks[0]!.locationId,
                  };
                else delete next[r.key];

                return next;
              })
            }
          />
          {m.purchasing_select()}
        </label>
        {selected[r.key] ? (
          <>
            <Input
              type="number"
              min="1"
              max="1000000"
              step={r.packSize ?? 1}
              aria-label={m.purchasing_quantity_for({ sku: r.sku })}
              value={selected[r.key]!.quantity}
              disabled={command.locked}
              onChange={(e) =>
                setSelected((prev) => ({
                  ...prev,
                  [r.key]: {
                    ...prev[r.key]!,
                    quantity: Number(e.target.value),
                  },
                }))
              }
            />
            <Select
              aria-label={m.purchasing_destination()}
              value={selected[r.key]!.locationId}
              options={r.stocks.map((s) => ({
                value: s.locationId,
                label: s.location,
              }))}
              disabled={command.locked}
              onValueChange={(v) => {
                if (v)
                  setSelected((prev) => ({
                    ...prev,
                    [r.key]: { ...prev[r.key]!, locationId: v },
                  }));
              }}
            />
            <small>
              {m.purchasing_result_cover({
                days: value(
                  r.demand.daily && r.available !== null
                    ? (r.available + selected[r.key]!.quantity) / r.demand.daily
                    : null,
                ),
              })}
            </small>
          </>
        ) : null}
      </div>
    ) : (
      m.common_empty_value()
    );
  const columns: DataTableColumn<PurchasingRecommendation>[] = [
    {
      key: 'sku',
      header: m.purchasing_product(),
      cell: (row) => (
        <div>
          <strong>{row.sku}</strong>
          <Disclosure>
            <summary>{m.purchasing_evidence()}</summary>
            {row.stocks.map((s) => (
              <p key={`${s.positionId}:${s.connectionId}`}>
                {s.location}: {m.purchasing_available()} {value(s.available)} ·{' '}
                {m.purchasing_reserved()} {value(s.reserved)}{' '}
                <WorkspaceDate value={s.observedAt} />{' '}
                <code>{s.observationId}</code>
              </p>
            ))}
            <p>
              {m.purchasing_demand_units({
                units: value(row.demand.units),
                days: row.demand.periodDays,
              })}{' '}
              {row.demand.observedAt ? (
                <WorkspaceDate value={row.demand.observedAt} />
              ) : null}
            </p>
            <p>
              {m.purchasing_terms_age()}{' '}
              {row.termsObservedAt ? (
                <WorkspaceDate value={row.termsObservedAt} />
              ) : (
                m.common_empty_value()
              )}
            </p>
            <p>
              {m.purchasing_rounding({
                raw: value(row.rawQuantity),
                pack: value(row.packSize),
                minimum: value(row.minimumQuantity),
              })}
            </p>
            <p>
              {m.purchasing_cover()}: {value(row.daysOfCover)}
            </p>
            <p>
              {m.purchasing_lead_time()}: {value(row.leadTimeDays)}
            </p>
            <p>
              {m.purchasing_order_by()}:{' '}
              {row.orderBy ? (
                <WorkspaceDate value={row.orderBy} />
              ) : (
                m.common_empty_value()
              )}
            </p>
            {row.rule ? (
              <p>
                {m.purchasing_rule({
                  minimum: row.rule.minimum,
                  target: row.rule.target,
                })}
              </p>
            ) : null}
            {canIgnore &&
            row.quantity !== null &&
            row.quantity > 0 &&
            !row.missing.length ? (
              <IgnoreRecommendation organizationId={organizationId} row={row} />
            ) : null}
          </Disclosure>
          <div className="purchasing-mobile-review">
            {renderReviewChoice(row)}
          </div>
        </div>
      ),
    },
    {
      key: 'stock',
      hideOnNarrow: true,
      header: m.purchasing_available(),
      numeric: true,
      cell: (r) => value(r.available),
    },
    {
      key: 'cover',
      hideOnNarrow: true,
      header: m.purchasing_cover(),
      numeric: true,
      cell: (r) => value(r.daysOfCover),
    },
    {
      key: 'lead',
      hideOnNarrow: true,
      header: m.purchasing_lead_time(),
      numeric: true,
      cell: (r) => value(r.leadTimeDays),
    },
    {
      key: 'orderBy',
      hideOnNarrow: true,
      header: m.purchasing_order_by(),
      cell: (r) =>
        r.orderBy ? (
          <WorkspaceDate value={r.orderBy} />
        ) : (
          m.common_empty_value()
        ),
    },
    {
      key: 'quantity',
      header: m.purchasing_quantity(),
      cell: (r) =>
        r.existingOrders.length ? (
          r.existingOrders.map((o) => (
            <Link
              key={o.id}
              to="/app/$organizationId/procurement/$purchaseOrderId"
              params={{ organizationId, purchaseOrderId: o.id }}
            >
              {o.reference} ({value(o.quantity)})
            </Link>
          ))
        ) : r.missing.length ? (
          <span className="procurement-cell">
            <Badge tone="warning">{m.purchasing_inputs_missing()}</Badge>
            <span>{r.missing.map(purchasingMissingLabel).join('; ')}</span>
          </span>
        ) : (
          value(r.quantity)
        ),
    },
    {
      key: 'decision',
      hideOnNarrow: true,
      header: m.purchasing_review(),
      cell: renderReviewChoice,
    },
  ];
  const chosen = rows.filter((r) => selected[r.key]);
  const invalidQuantity = chosen.some((r) => {
    const quantity = selected[r.key]!.quantity;

    return (
      !Number.isSafeInteger(quantity) ||
      quantity < r.minimumQuantity! ||
      quantity <= 0 ||
      quantity > 1_000_000 ||
      quantity % r.packSize! !== 0
    );
  });
  const currency = chosen[0]?.unitPrice?.currency;
  const priced =
    chosen.length > 0 &&
    !invalidQuantity &&
    !!currency &&
    chosen.every((r) => r.unitPrice?.currency === currency);
  const total = priced
    ? chosen.reduce(
        (sum, r) =>
          sum +
          priceUnits(r.unitPrice!.amount) * BigInt(selected[r.key]!.quantity),
        0n,
      )
    : null;
  const minimum = rows.find((r) => r.orderMinimumValue)?.orderMinimumValue;
  const belowMinimum =
    minimum &&
    (total === null ||
      currency !== minimum.currency ||
      total < priceUnits(minimum.amount));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{rows[0]!.supplierName}</CardTitle>
      </CardHeader>
      <CardContent>
        <DataTable
          caption={m.purchasing_supplier_recommendations({
            supplier: rows[0]!.supplierName,
          })}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          density="compact"
          variant="plain"
        />
        {canManage && chosen.length ? (
          <form
            className="purchasing-plan-form"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <p>
              {m.purchasing_order_value({
                amount: value(
                  total === null ? null : Number(total) / 100_000_000,
                ),
                currency: currency ?? '',
              })}
            </p>
            {invalidQuantity ? (
              <Alert tone="warning">{m.purchasing_quantity_invalid()}</Alert>
            ) : null}
            {belowMinimum ? (
              <Alert tone="warning">
                {m.purchasing_minimum_warning({
                  amount: minimum.amount,
                  currency: minimum.currency,
                })}
              </Alert>
            ) : null}
            <form.Field name="reference">
              {(field) => (
                <Input
                  aria-label={m.purchasing_reference()}
                  placeholder={m.purchasing_reference()}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  disabled={command.locked}
                />
              )}
            </form.Field>
            <form.Field name="reason">
              {(field) => (
                <Input
                  aria-label={m.purchasing_reason()}
                  placeholder={m.purchasing_reason()}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  disabled={command.locked}
                />
              )}
            </form.Field>
            {command.error ? (
              <Alert tone="danger" role="alert">
                {procurementError(command.error)}
              </Alert>
            ) : null}
            <Button
              disabled={command.isPending || invalidQuantity}
              type="submit"
            >
              {command.uncertain ? m.common_retry() : m.purchasing_propose()}
            </Button>
          </form>
        ) : null}
        {result ? <p role="status">{m.purchasing_saved_plan()}</p> : null}
      </CardContent>
    </Card>
  );
}

function PlanResult({
  plan,
  organizationId,
  done,
}: {
  plan: PurchasingPlan;
  organizationId: string;
  done?: () => void;
}) {
  const client = useQueryClient();
  const command = useMutation({
    mutationFn: (outcome: 'approved' | 'rejected' | 'check' | 'execute') =>
      outcome === 'check'
        ? checkPurchasingPlan(organizationId, plan.id)
        : outcome === 'execute'
          ? executePurchasingPlan(organizationId, plan.id)
          : decidePurchasingPlan(organizationId, plan.id, {
              decisionId: plan.decisionId!,
              outcome,
            }),
    onSuccess: () => {
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
      done?.();
    },
  });
  const states = {
    approval_required: m.purchasing_state_approval,
    approved: m.purchasing_state_approved,
    rejected: m.purchasing_state_rejected,
    withheld: m.purchasing_state_withheld,
    uncertain: m.purchasing_state_uncertain,
    verified: m.purchasing_state_verified,
    failed: m.purchasing_state_failed,
    expired: m.purchasing_state_expired,
  };

  return (
    <div className="purchasing-plan-result">
      <strong>{plan.order.reference}</strong>{' '}
      <Badge>{states[plan.state]()}</Badge>
      {plan.state === 'verified' ? (
        <Link
          to="/app/$organizationId/procurement/$purchaseOrderId"
          params={{ organizationId, purchaseOrderId: plan.order.id }}
        >
          {m.purchasing_open_order()}
        </Link>
      ) : null}
      {plan.state === 'approval_required' &&
      plan.decisionId &&
      plan.canApprove ? (
        <>
          <Button
            disabled={command.isPending}
            onClick={() => command.mutate('approved')}
          >
            {m.purchasing_approve()}
          </Button>
          <Button
            variant="outline"
            disabled={command.isPending}
            onClick={() => command.mutate('rejected')}
          >
            {m.purchasing_reject()}
          </Button>
        </>
      ) : null}
      {plan.state === 'approved' && plan.canExecute ? (
        <Button
          disabled={command.isPending}
          onClick={() => command.mutate('execute')}
        >
          {m.purchasing_resume()}
        </Button>
      ) : null}
      {plan.state === 'uncertain' ? (
        <Button
          variant="outline"
          disabled={command.isPending}
          onClick={() => command.mutate('check')}
        >
          {m.purchasing_check()}
        </Button>
      ) : null}
      {plan.failure ? <p>{plan.failure}</p> : null}
      {command.error ? (
        <Alert tone="danger">{procurementError(command.error)}</Alert>
      ) : null}
    </div>
  );
}

function IgnoreRecommendation({
  organizationId,
  row,
}: {
  organizationId: string;
  row: PurchasingRecommendation;
}) {
  const [recorded, setRecorded] = useState(false);
  const command = useCommand(
    organizationId,
    (body: { id: string; supplierId: string; skuId: string; reason: string }) =>
      ignorePurchasingRecommendation(organizationId, body),
    () => setRecorded(true),
  );
  const form = useForm({
    defaultValues: { reason: '' },
    onSubmit: async ({ value }) =>
      command.submit({
        id: crypto.randomUUID(),
        supplierId: row.supplierId,
        skuId: row.skuId,
        reason: value.reason,
      }),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="reason">
        {(field) => (
          <Input
            aria-label={m.purchasing_ignore_reason()}
            placeholder={m.purchasing_ignore_reason()}
            required
            value={field.state.value}
            disabled={command.locked}
            onChange={(e) => field.handleChange(e.target.value)}
          />
        )}
      </form.Field>
      <Button
        type="submit"
        variant="outline"
        disabled={command.isPending || recorded}
      >
        {command.uncertain ? m.common_retry() : m.purchasing_ignore()}
      </Button>
      {command.error ? (
        <Alert tone="danger">{procurementError(command.error)}</Alert>
      ) : null}
      {recorded ? <p role="status">{m.purchasing_ignore_recorded()}</p> : null}
    </form>
  );
}

/** Reviews only the saved plan selected from Needs you, with its current approval rights. */
export function PurchasingPlanReview({
  organizationId,
  planId,
  done,
}: {
  organizationId: string;
  planId: string;
  done: () => void;
}) {
  const query = useQuery(purchasingPlansOptions(organizationId));
  if (query.isPending) return <p role="status">{m.purchasing_loading()}</p>;
  if (query.error)
    return (
      <Alert tone="danger">
        {procurementError(query.error)}
        <Button variant="outline" onClick={() => void query.refetch()}>
          {m.common_retry()}
        </Button>
      </Alert>
    );
  const plan = query.data.items.find((item) => item.id === planId);
  if (!plan)
    return (
      <Empty>
        <h3>{m.purchasing_outcomes_empty()}</h3>
      </Empty>
    );

  return (
    <div>
      <PlanResult plan={plan} organizationId={organizationId} done={done} />
      <DataTable
        caption={m.purchasing_review()}
        rows={plan.order.lines}
        rowKey={(line) => line.id}
        columns={[
          {
            key: 'sku',
            header: m.purchasing_product(),
            cell: (line) => line.description,
          },
          {
            key: 'quantity',
            header: m.purchasing_quantity(),
            numeric: true,
            cell: (line) => formatNumber(line.quantity),
          },
        ]}
      />
    </div>
  );
}
