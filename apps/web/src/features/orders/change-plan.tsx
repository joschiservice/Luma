import type {
  CaseSummary,
  OrderChangePlan,
  OrderChangePlanQuery,
  OrderChangePlans,
  OrderDetail,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import {
  type OperationalState,
  StatePill,
} from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Route as RouteIcon } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { z } from 'zod';

import { permissionLabel } from '../../kit/identity/permission-text';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { OrderSection } from '../../shared/orders/order-section';
import { formatQuantity, statusLabels } from '../../shared/orders/presentation';
import { changePlanOptions, orderOptions } from './data';

type Plan = OrderChangePlan;

type Step = Plan['steps'][number];

type Reason = Plan['safety']['reasons'][number]['code'];

const api = createWebApiClient();

const kindLabels: Record<Plan['change']['kind'], () => string> = {
  quantity: m.orders_plan_kind_quantity,
  item: m.orders_plan_kind_item,
  address: m.orders_plan_kind_address,
  location: m.orders_plan_kind_location,
  cancellation: m.orders_plan_kind_cancellation,
};

const safety: Record<
  Plan['safety']['state'],
  [OperationalState, () => string]
> = {
  safe: ['verified', m.orders_plan_safety_safe],
  unsafe: ['attention', m.orders_plan_safety_unsafe],
  unknown: ['waiting', m.orders_plan_safety_unknown],
};

const reasonText: Record<Reason, () => string> = {
  work_started: m.orders_plan_reason_work_started,
  shipped: m.orders_plan_reason_shipped,
  fulfilled_beyond_target: m.orders_plan_reason_fulfilled_beyond_target,
  cancelled: m.orders_plan_reason_cancelled,
  closed: m.orders_plan_reason_closed,
  stale_evidence: m.orders_plan_reason_stale_evidence,
  incomplete_evidence: m.orders_plan_reason_incomplete_evidence,
  ambiguous_line: m.orders_plan_reason_ambiguous_line,
  unknown_progress: m.orders_plan_reason_unknown_progress,
  unknown_value: m.orders_plan_reason_unknown_value,
  authority_unknown: m.orders_plan_reason_authority_unknown,
  authority_conflict: m.orders_plan_reason_authority_conflict,
  no_fulfilment_source: m.orders_plan_reason_no_fulfilment_source,
  fulfilment_hidden: m.orders_plan_reason_fulfilment_hidden,
};

const ackLabels: Record<
  Plan['acknowledgements'][number]['state'],
  [OperationalState, () => string]
> = {
  reflects: ['verified', m.orders_plan_ack_reflects],
  differs: ['attention', m.orders_plan_ack_differs],
  unknown: ['waiting', m.orders_plan_ack_unknown],
};

const roleLabels: Record<NonNullable<Step['role']>, () => string> = {
  warehouse: m.orders_plan_role_warehouse,
  carrier: m.orders_plan_role_carrier,
  finance: m.orders_plan_role_finance,
  operator: m.orders_plan_role_operator,
};

const actionText: Record<
  Step['action'],
  (input: { system: string }) => string
> = {
  check_progress: m.orders_plan_action_check_progress,
  confirm_picking: m.orders_plan_action_confirm_picking,
  stop_work: m.orders_plan_action_stop_work,
  hold_for_address: m.orders_plan_action_hold_for_address,
  stop_and_reassign: m.orders_plan_action_stop_and_reassign,
  return_or_refund: m.orders_plan_action_return_or_refund,
  update_quantity: m.orders_plan_action_update_quantity,
  cancel_order: m.orders_plan_action_cancel_order,
  update_address: m.orders_plan_action_update_address,
  reassign_location: m.orders_plan_action_reassign_location,
  carrier_redirect: m.orders_plan_action_carrier_redirect,
  notify_added_units: m.orders_plan_action_notify_added_units,
  notify_customer: m.orders_plan_action_notify_customer,
  escalate_unsafe: m.orders_plan_action_escalate_unsafe,
  escalate_unknown: m.orders_plan_action_escalate_unknown,
};

const blockedText: Record<
  NonNullable<Step['blockedBy']>,
  (input: { system: string }) => string
> = {
  not_granted: m.orders_plan_blocked_not_granted,
  unavailable: m.orders_plan_blocked_unavailable,
  authority: m.orders_plan_blocked_authority,
  unmapped: m.orders_plan_blocked_unmapped,
  whole_units: m.orders_plan_blocked_whole_units,
  observe_only: m.orders_plan_blocked_observe_only,
  unsafe: m.orders_plan_blocked_unsafe,
  unknown: m.orders_plan_blocked_unknown,
};

/** A line the reader can propose a quantity for: matched across sources by its comparison key. */
export interface PlanLine {
  key: string;
  label: string;
  quantity: string | null;
  unit: string;
}

/** Lines of the source shown first that sources can be matched on, once per comparison key. */
export function planLines(
  detail: OrderDetail,
  connectionId?: string,
): PlanLine[] {
  const source =
    detail.sources.find((item) => item.connectionId === connectionId) ??
    detail.sources.find(
      (item) => item.connectionId === detail.authority.lines?.connectionId,
    ) ??
    detail.sources[0];
  const seen = new Set<string>();

  return (source?.lines ?? []).flatMap((line) => {
    if (!line.comparisonKey || seen.has(line.comparisonKey)) return [];
    seen.add(line.comparisonKey);

    return [
      {
        key: line.comparisonKey,
        label:
          [line.title, line.skuCode].filter(Boolean).join(' · ') || line.id,
        quantity: line.currentQuantity,
        unit: line.unit,
      },
    ];
  });
}

const locationAllocations = z.array(z.tuple([z.string(), z.string()]));

/** Parses JSON text, or returns undefined when it is not valid JSON. */
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function valueText(
  plan: Plan,
  value: string | null,
  locationNames: ReadonlyMap<string, string>,
) {
  if (value === null) return m.orders_plan_value_unknown();
  if (plan.change.kind === 'quantity' || plan.change.kind === 'item')
    return formatQuantity(value, plan.change.unit ?? 'each');
  if (plan.change.kind === 'cancellation') return statusLabels[value] ?? value;
  if (plan.change.kind === 'location') {
    const parsed = locationAllocations.safeParse(parseJson(value));
    if (!parsed.success) return value;
    const names = parsed.data.map(([id]) => locationNames.get(id));

    return names.every(Boolean)
      ? names.join(', ')
      : m.orders_plan_location_value({ count: parsed.data.length });
  }

  return value;
}

function PlanStep({
  step,
  system,
  action,
}: {
  step: Step;
  system: string;
  action?: ReactNode;
}) {
  return (
    <li className="order-plan-step" data-performer={step.performer}>
      <div className="order-plan-step-head">
        <Badge tone={step.performer === 'luma' ? 'accent' : 'neutral'}>
          {step.performer === 'luma'
            ? m.orders_plan_performer_luma()
            : m.orders_plan_performer_person({
                role: roleLabels[step.role ?? 'operator'](),
              })}
        </Badge>
        <span>{actionText[step.action]({ system })}</span>
      </div>
      {step.performer === 'luma' ? (
        <p className="order-note">
          {step.blockedBy
            ? blockedText[step.blockedBy]({ system })
            : step.viewerCanRequest || !step.permission
              ? m.orders_plan_step_ready()
              : m.orders_plan_step_needs_permission({
                  permission: permissionLabel(step.permission, step.permission),
                })}
        </p>
      ) : null}
      {step.performer === 'luma' &&
      step.executable &&
      step.viewerCanRequest &&
      action ? (
        <div className="order-plan-step-action">{action}</div>
      ) : null}
    </li>
  );
}

/**
 * Says what each system shows for a detected quantity change, led by the system that holds
 * order-line authority: “Luma ERP sets this quantity to 1; Shopify still shows 2; JTL doesn’t
 * report it.” Null for other changes or when the authority's value is unknown.
 */
function quantityStory(
  plan: Plan,
  authority: string | null,
  sourceLabel: (connectionId: string) => string,
) {
  if (
    plan.change.origin !== 'detected' ||
    (plan.change.kind !== 'quantity' && plan.change.kind !== 'item')
  )
    return null;
  const lead = plan.acknowledgements.find(
    (item) => item.connectionId === authority && item.value !== null,
  );
  if (!lead?.value) return null;
  const quantity = (value: string) =>
    formatQuantity(value, plan.change.unit ?? 'each');
  const parts = [
    m.orders_plan_story_authority({
      system: sourceLabel(lead.connectionId),
      quantity: quantity(lead.value),
    }),
    ...plan.acknowledgements
      .filter((item) => item !== lead)
      .map((item) => {
        const system = sourceLabel(item.connectionId);
        if (item.value === null)
          return m.orders_plan_story_not_reported({ system });
        if (item.state === 'reflects')
          return m.orders_plan_story_reflects({ system });

        return item.state === 'differs'
          ? m.orders_plan_story_differs({
              system,
              quantity: quantity(item.value),
            })
          : m.orders_plan_story_unconfirmed({
              system,
              quantity: quantity(item.value),
            });
      }),
  ];

  return `${parts.join('; ')}.`;
}

function PlanCard({
  plan,
  sourceLabel,
  locationNames,
  editAction,
  authority,
}: {
  plan: Plan;
  sourceLabel: (connectionId: string) => string;
  locationNames: ReadonlyMap<string, string>;
  editAction?: ((step: Step) => ReactNode) | undefined;
  authority: string | null;
}) {
  const [state, label] = safety[plan.safety.state];
  const ackColumns: DataTableColumn<Plan['acknowledgements'][number]>[] = [
    {
      key: 'system',
      header: m.orders_plan_column_system(),
      cell: (row) => sourceLabel(row.connectionId),
    },
    {
      key: 'value',
      header: m.orders_plan_column_value(),
      cell: (row) =>
        plan.change.kind === 'address'
          ? m.common_not_reported()
          : valueText(plan, row.value, locationNames),
    },
    {
      key: 'state',
      header: m.orders_plan_column_state(),
      cell: (row) => {
        const [pill, text] = ackLabels[row.state];

        return <StatePill state={pill}>{text()}</StatePill>;
      },
    },
    {
      key: 'read',
      header: m.orders_plan_column_read(),
      cell: (row) => (
        <span className="orders-cell-stack">
          <WorkspaceDate value={row.readAt} />
          {row.fresh ? null : <small>{m.orders_plan_ack_stale()}</small>}
        </span>
      ),
    },
  ];
  const line = plan.change.line
    ? [plan.change.line.title, plan.change.line.skuCode]
        .filter(Boolean)
        .join(' · ')
    : null;
  const story = quantityStory(plan, authority, sourceLabel);

  return (
    <article className="order-plan">
      <header className="order-plan-head">
        <div className="orders-cell-stack">
          <h3>{kindLabels[plan.change.kind]()}</h3>
          <small>
            {plan.change.origin === 'detected'
              ? m.orders_plan_origin_detected()
              : m.orders_plan_origin_proposed()}
            {' · '}
            {line ?? (plan.change.lineKey ? '' : m.orders_plan_whole_order())}
          </small>
          {plan.change.kind === 'address' ? null : (
            <span>
              {m.orders_plan_change_value({
                from: valueText(plan, plan.change.from, locationNames),
                to: valueText(plan, plan.change.to, locationNames),
              })}
            </span>
          )}
        </div>
        <StatePill state={state}>{label()}</StatePill>
      </header>
      {story ? <p className="order-plan-story">{story}</p> : null}
      {plan.safety.reasons.length ? (
        <ul className="order-plan-reasons">
          {plan.safety.reasons.map((reason) => (
            <li key={`${reason.code}:${reason.connectionId ?? ''}`}>
              {reasonText[reason.code]()}
              {reason.connectionId ? (
                <small>
                  {' '}
                  {m.orders_plan_reason_source({
                    source: sourceLabel(reason.connectionId),
                  })}
                </small>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {plan.safety.state === 'unknown' ? (
        <p className="order-note">{m.orders_plan_safety_unknown_help()}</p>
      ) : null}
      <h4>{m.orders_plan_systems_title()}</h4>
      <DataTable
        caption={m.orders_plan_systems_caption()}
        columns={ackColumns}
        rows={plan.acknowledgements}
        rowKey={(row) => row.connectionId}
        density="compact"
      />
      {plan.shipped.length ? (
        <>
          <h4>{m.orders_plan_shipped_title()}</h4>
          <ul className="order-plan-shipped">
            {plan.shipped.map((item) => (
              <li key={item.lineKey}>
                <strong>
                  {item.units === null
                    ? m.orders_plan_value_unknown()
                    : m.orders_plan_shipped_units({
                        units: formatQuantity(item.units, item.unit ?? 'each'),
                      })}
                </strong>{' '}
                <small>
                  {item.basis === 'authority' && item.connectionId
                    ? m.orders_plan_shipped_authority({
                        source: sourceLabel(item.connectionId),
                      })
                    : item.basis === 'maximum' && item.connectionId
                      ? m.orders_plan_shipped_maximum({
                          source: sourceLabel(item.connectionId),
                        })
                      : m.orders_plan_shipped_unknown()}
                </small>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4>{m.orders_plan_steps_title()}</h4>
      {plan.steps.length ? (
        <ol className="order-plan-steps">
          {plan.steps.map((step) => {
            const system = step.connectionId
              ? sourceLabel(step.connectionId)
              : m.orders_plan_any_system();

            return (
              <PlanStep
                key={step.id}
                step={step}
                system={system}
                action={editAction?.(step)}
              />
            );
          })}
        </ol>
      ) : (
        <p className="order-note">{m.orders_plan_steps_none()}</p>
      )}
    </article>
  );
}

function ProposeQuantity({
  lines,
  proposal,
  propose,
  clear,
  initialLine,
}: {
  lines: PlanLine[];
  proposal: OrderChangePlanQuery | null;
  propose: (lineKey: string, quantity: string) => void;
  clear: () => void;
  /** The line the reader chose to plan for; its quantity field takes focus. */
  initialLine?: string | undefined;
}) {
  const id = useId();
  const chosen = lines.some((item) => item.key === initialLine)
    ? initialLine
    : undefined;
  const [line, setLine] = useState(
    chosen ?? proposal?.lineKey ?? lines[0]?.key ?? '',
  );
  const [quantity, setQuantity] = useState(proposal?.quantity ?? '');
  const [invalid, setInvalid] = useState(false);
  if (!lines.length)
    return <p className="order-note">{m.orders_plan_propose_no_lines()}</p>;

  return (
    <form
      className="order-plan-propose"
      aria-label={m.orders_plan_propose_title()}
      onSubmit={(event) => {
        event.preventDefault();
        const value = quantity.trim();
        if (!/^\d{1,14}(\.\d{1,6})?$/.test(value) || !line) {
          setInvalid(true);

          return;
        }
        setInvalid(false);
        propose(line, value);
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${id}-line`}>
          {m.orders_plan_propose_line()}
        </FieldLabel>
        <Select
          id={`${id}-line`}
          aria-label={m.orders_plan_propose_line()}
          value={line}
          onValueChange={(value) => setLine(value ?? '')}
          options={lines.map((item) => ({
            value: item.key,
            label: item.quantity
              ? `${item.label} (${formatQuantity(item.quantity, item.unit)})`
              : item.label,
          }))}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-quantity`}>
          {m.orders_plan_propose_quantity()}
        </FieldLabel>
        <Input
          id={`${id}-quantity`}
          // The reader opened the plan from this line's menu to enter its quantity.
          autoFocus={!!chosen}
          inputMode="decimal"
          value={quantity}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={(event) => setQuantity(event.target.value)}
        />
      </Field>
      <div className="order-plan-propose-actions">
        <Button type="submit" variant="outline">
          {m.orders_plan_propose_submit()}
        </Button>
        {proposal ? (
          <Button type="button" variant="ghost" onClick={clear}>
            {m.orders_plan_propose_clear()}
          </Button>
        ) : null}
      </div>
      {invalid ? (
        <p id={`${id}-error`} role="alert" className="order-note">
          {m.orders_plan_propose_invalid()}
        </p>
      ) : null}
    </form>
  );
}

/** What the change plan content needs: plans, their read state and the proposal control. */
export interface OrderChangePlanProps {
  plans?: OrderChangePlans | undefined;
  loading?: boolean;
  failed?: boolean;
  sources: { connectionId: string; label: string }[];
  locationNames?: ReadonlyMap<string, string>;
  /** Lines a quantity can be proposed for; omit to hide the proposal control. */
  lines?: PlanLine[];
  proposal?: OrderChangePlanQuery | null;
  propose?: (lineKey: string, quantity: string) => void;
  clear?: () => void;
  editAction?: (step: Step) => ReactNode;
  /** The connection that holds order-line authority, which leads a quantity plan's summary. */
  authority?: string | null;
  /** The line the reader chose to plan for, by comparison key. */
  initialLine?: string | undefined;
}

function sourceLabels(sources: OrderChangePlanProps['sources']) {
  return (connectionId: string) =>
    sources.find((source) => source.connectionId === connectionId)?.label ??
    m.orders_plan_any_system();
}

/**
 * Presents order change plans: what changes, which systems show it, what shipped, whether the
 * change is still safe and the ordered steps for Luma and for people. With `lines`, a form
 * proposes a quantity first. `editAction` renders the control that hands an executable Luma
 * step to the owning app's own review.
 */
export function OrderChangePlanContent({
  plans,
  loading = false,
  failed = false,
  sources,
  locationNames = new Map(),
  lines,
  proposal = null,
  propose,
  clear,
  editAction,
  authority = null,
  initialLine,
}: OrderChangePlanProps) {
  const sourceLabel = sourceLabels(sources);

  return (
    <div className="order-plan-body" aria-busy={loading}>
      {lines && propose && clear ? (
        <ProposeQuantity
          key={`${proposal?.lineKey ?? ''}:${proposal?.quantity ?? ''}:${initialLine ?? ''}`}
          lines={lines}
          proposal={proposal}
          propose={propose}
          clear={clear}
          initialLine={initialLine}
        />
      ) : null}
      {plans?.hidden.includes('fulfillments') ? (
        <p className="order-note" role="status">
          {m.orders_plan_hidden()}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="order-note">
          {m.orders_plan_failed()}
        </p>
      ) : !plans ? (
        loading ? (
          <p role="status" className="order-note">
            {m.orders_plan_loading()}
          </p>
        ) : null
      ) : plans.plans.length ? (
        plans.plans.map((plan) => (
          <PlanCard
            key={`${plan.change.kind}:${plan.change.lineKey ?? ''}`}
            plan={plan}
            sourceLabel={sourceLabel}
            locationNames={locationNames}
            editAction={editAction}
            authority={authority}
          />
        ))
      ) : (
        <p className="order-note" role="status">
          {plans.comparisonState === 'inconclusive'
            ? m.orders_plan_inconclusive()
            : m.orders_plan_none_detected()}
        </p>
      )}
    </div>
  );
}

/** Presents order change plans in an order section, as on a case about the order. */
export function OrderChangePlanView({
  title,
  action,
  ...props
}: OrderChangePlanProps & { title?: string; action?: ReactNode }) {
  return (
    <OrderSection
      title={title ?? m.orders_plan_title()}
      icon={RouteIcon}
      description={m.orders_plan_description()}
      action={action}
    >
      <OrderChangePlanContent {...props} />
    </OrderSection>
  );
}

/**
 * Lists the changes a plan covers in one line each, with whether it is still safe, so the order
 * page can point to the full plan. Renders nothing while there is nothing to plan.
 */
export function OrderChangeSummary({
  plans,
  failed = false,
  locationNames = new Map(),
  review,
}: Pick<OrderChangePlanProps, 'plans' | 'failed' | 'locationNames'> & {
  /** Opens the full plan. */
  review: () => void;
}) {
  if (failed)
    return (
      <p role="alert" className="order-note">
        {m.orders_plan_failed()}
      </p>
    );
  if (!plans?.plans.length) return null;

  return (
    <section className="order-changes" aria-label={m.orders_plan_title()}>
      <ul>
        {plans.plans.map((plan) => {
          const [state, label] = safety[plan.safety.state];
          const line = plan.change.line
            ? (plan.change.line.title ?? plan.change.line.skuCode)
            : null;

          return (
            <li key={`${plan.change.kind}:${plan.change.lineKey ?? ''}`}>
              <RouteIcon aria-hidden="true" />
              <span className="orders-cell-stack">
                <strong>
                  {line
                    ? m.orders_plan_summary_line({
                        kind: kindLabels[plan.change.kind](),
                        line,
                      })
                    : kindLabels[plan.change.kind]()}
                </strong>
                <small>
                  {plan.change.origin === 'detected'
                    ? m.orders_plan_origin_detected()
                    : m.orders_plan_origin_proposed()}
                  {plan.change.kind === 'address'
                    ? null
                    : ` · ${m.orders_plan_change_value({
                        from: valueText(plan, plan.change.from, locationNames),
                        to: valueText(plan, plan.change.to, locationNames),
                      })}`}
                  {` · ${m.orders_plan_summary_steps({ count: plan.steps.length })}`}
                </small>
              </span>
              <StatePill state={state}>{label()}</StatePill>
            </li>
          );
        })}
      </ul>
      <Button variant="outline" size="sm" onClick={review}>
        {m.orders_plan_review({ count: plans.plans.length })}
        <ArrowRight aria-hidden="true" />
      </Button>
    </section>
  );
}

/** Location names reported by the order's fulfilments, for reading location values. */
export function orderLocationNames(detail: OrderDetail) {
  const names = new Map<string, string>();
  for (const work of detail.fulfillments)
    if (work.location?.locationId && work.location.name)
      names.set(work.location.locationId, work.location.name);

  return names;
}

const uuid = z.uuid();

/**
 * Finds the order a case is about: an order subject by Luma ID, or by source ID within its
 * connection when exactly one order matches, or a fulfillment's order. Null when none is known.
 */
function caseOrderOptions(
  organizationId: string,
  subject: CaseSummary['subject'],
) {
  const connectionId = subject.scope[0];

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'case-order',
      subject.kind,
      subject.id,
      connectionId ?? '',
    ],
    queryFn: async ({ signal }): Promise<string | null> => {
      if (subject.kind === 'order' && uuid.safeParse(subject.id).success)
        return subject.id;
      if (
        subject.kind === 'order' &&
        connectionId &&
        uuid.safeParse(connectionId).success
      ) {
        const { ids } = await api.records.resolve(
          {
            params: { organizationId },
            query: { connectionId, kind: 'order', externalId: subject.id },
          },
          { signal },
        );

        return ids.length === 1 ? (ids[0] ?? null) : null;
      }
      if (subject.kind === 'fulfillment' && uuid.safeParse(subject.id).success)
        return (
          await api.fulfillment.get(
            { params: { organizationId, fulfillmentId: subject.id } },
            { signal },
          )
        ).order.id;

      return null;
    },
  });
}

/**
 * Shows the change plan of the order a case is about, with detected changes only. Luma steps
 * link to the order, which opens the owning app's review prefilled. Renders nothing when the
 * case concerns no order or the reader can't read it.
 */
export function CaseOrderChangePlan({
  organizationId,
  subject,
  from,
}: {
  organizationId: string;
  subject: CaseSummary['subject'];
  from: string;
}) {
  const relevant = subject.kind === 'order' || subject.kind === 'fulfillment';
  const order = useQuery({
    ...caseOrderOptions(organizationId, subject),
    enabled: relevant,
  });
  const orderId = order.data ?? null;
  const detail = useQuery({
    ...orderOptions(organizationId, orderId ?? ''),
    enabled: Boolean(orderId),
  });
  const plans = useQuery({
    ...changePlanOptions(
      organizationId,
      orderId ?? '',
      null,
      detail.data?.asOf ?? null,
    ),
    enabled: Boolean(orderId && detail.data),
  });
  if (!orderId || !detail.data) return null;

  return (
    <OrderChangePlanView
      title={m.orders_plan_case_title({
        order:
          detail.data.order.displayNumber ??
          m.orders_plan_case_order_fallback(),
      })}
      plans={plans.data}
      loading={plans.isPending}
      failed={plans.isError}
      sources={detail.data.sources}
      locationNames={orderLocationNames(detail.data)}
      authority={detail.data.authority.lines?.connectionId ?? null}
      action={
        <Link
          to="/app/$organizationId/orders/$orderId"
          params={{ organizationId, orderId }}
          search={{ from }}
          className="orders-empty-link"
        >
          {m.orders_plan_case_open()}{' '}
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      }
      editAction={(step) =>
        step.connectionId ? (
          <Link
            to="/app/$organizationId/orders/$orderId"
            params={{ organizationId, orderId }}
            search={{ from, edit: step.connectionId }}
            hash={`source-${step.connectionId}`}
          >
            {m.orders_plan_open_edit({
              system:
                detail.data.sources.find(
                  (source) => source.connectionId === step.connectionId,
                )?.label ?? m.orders_plan_any_system(),
            })}
          </Link>
        ) : null
      }
    />
  );
}
