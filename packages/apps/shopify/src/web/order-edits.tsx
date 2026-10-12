import './order-edits.css';

import type { AppUiProps } from '@luma/app-host/web';
import { formatCurrency, formatTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import {
  type OperationalState,
  StatePill,
} from '@luma/ui/components/primitives/state';
import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';

import {
  editTouchesHold,
  lineBlockerReason,
  type MoneyBag,
  type OrderEditBlockerReason,
  orderEditBlockerReason,
  type OrderEditChange,
  orderEditSnapshot,
  type OrderEditView,
  orderEditView,
  orderLineAuthority,
} from '../domain/order-edits.js';

const blockerText: Record<OrderEditBlockerReason, () => string> = {
  write_access: m.shopify_order_edit_blocker_write_access,
  incomplete: m.shopify_order_edit_blocker_incomplete,
  cancelled: m.shopify_order_edit_blocker_cancelled,
  closed: m.shopify_order_edit_blocker_closed,
  authority: m.shopify_order_edit_blocker_authority,
  unknown_line: m.shopify_order_edit_blocker_unknown_line,
  no_change: m.shopify_order_edit_blocker_no_change,
  partially_fulfilled: m.shopify_order_edit_blocker_partially_fulfilled,
  fulfillment_started: m.shopify_order_edit_blocker_fulfillment_started,
  fulfillment_requested: m.shopify_order_edit_blocker_fulfillment_requested,
  fulfillment_unknown: m.shopify_order_edit_blocker_fulfillment_unknown,
};

const inspection = z.object({
  snapshot: orderEditSnapshot,
  granted: z.array(z.string()),
  authority: orderLineAuthority.nullable(),
  observeOnly: z.boolean(),
  runs: z.array(orderEditView),
});

const recent = z.object({ runs: z.array(orderEditView) });

/** Whether an edit still waits on a person, so the editor opens by itself. */
const waiting = (view: OrderEditView) =>
  view.observeOnly ||
  view.canExecute ||
  ['approval_required', 'uncertain', 'recovery_required'].includes(view.state);

function money(value: MoneyBag['shop']) {
  const amount = Number(value.amount);
  try {
    return Number.isFinite(amount)
      ? formatCurrency(amount, value.currencyCode)
      : `${value.amount} ${value.currencyCode}`;
  } catch {
    return `${value.amount} ${value.currencyCode}`;
  }
}

/** Shows the shop amount, and the customer's amount when Shopify presents another currency. */
function Amount({ value }: { value: MoneyBag | null }) {
  if (!value) return <>{m.common_not_reported()}</>;

  return (
    <>
      {money(value.shop)}
      {value.presentment.currencyCode !== value.shop.currencyCode ? (
        <span className="field-help">
          {' '}
          {m.shopify_order_edit_customer_currency({
            amount: money(value.presentment),
          })}
        </span>
      ) : null}
    </>
  );
}

/** The person-facing message for a saved edit, in the reader's language. */
function message(view: OrderEditView) {
  if (view.observeOnly) return m.shopify_order_edit_message_observe_only();
  if (view.state === 'verified') return m.shopify_order_edit_message_verified();
  if (view.state === 'uncertain')
    return m.shopify_order_edit_message_uncertain();
  if (view.state === 'recovery_required')
    return m.shopify_order_edit_message_accepted();
  if (view.state === 'denied')
    return {
      withheld: m.shopify_order_edit_message_withheld,
      not_applied: m.shopify_order_edit_message_not_applied,
      rejected: m.shopify_order_edit_message_rejected,
      policy: m.shopify_order_edit_message_policy,
      changed: m.shopify_order_edit_message_changed,
      expired: m.shopify_order_edit_message_expired,
    }[view.denial ?? 'expired']();
  if (view.canExecute || view.approved)
    return m.shopify_order_edit_message_approved();
  if (view.state === 'approval_required')
    return view.canApprove
      ? m.shopify_order_edit_message_awaiting_self()
      : m.shopify_order_edit_message_awaiting_other();

  return m.shopify_order_edit_message_preview();
}

/**
 * Lets people with order edit permission change quantities of unfulfilled Shopify order lines
 * through an exact, approved preview, and follow it until a fresh read verifies it.
 */
export function ShopifyOrderEdits({
  connectionId,
  orderId,
  services,
  headingLevel = 4,
}: {
  connectionId: string;
  orderId: string;
  services: AppUiProps['services'];
  headingLevel?: 2 | 3 | 4;
}) {
  const Heading = `h${headingLevel}` as const;
  const id = useId();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<z.infer<typeof inspection> | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState(true);
  const [review, setReview] = useState<OrderEditView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const requestId = useRef<string | null>(null);
  const generation = useRef(0);
  const compose = useRef(false);

  // Persisted edits only: the order page reads Shopify again only when someone opens the editor.
  useEffect(() => {
    let active = true;
    services
      .request('order-edit-recent', { connectionId, orderId })
      .then((value) => {
        const latest = recent.parse(value).runs[0];
        if (active && latest && waiting(latest)) setOpen(true);
      })
      .catch(() => {
        /* The editor stays closed; opening it reports problems. */
      });

    return () => {
      active = false;
    };
  }, [connectionId, orderId, services]);

  useEffect(() => {
    if (!open) return;
    const current = ++generation.current;
    setPending(true);
    setData(null);
    setError('');
    requestId.current = null;
    services
      .request('order-edit-inspect', { connectionId, orderId })
      .then((value) => {
        if (current !== generation.current) return;
        const result = inspection.parse(value);
        setData(result);
        setReview(compose.current ? null : (result.runs[0] ?? null));
        compose.current = false;
        setTargets({});
      })
      .catch((reason) => {
        if (current === generation.current) setError(services.error(reason));
      })
      .finally(() => {
        if (current === generation.current) setPending(false);
      });

    return () => {
      generation.current++;
    };
  }, [open, connectionId, orderId, services, refresh]);

  const snapshot = data?.snapshot;
  const change: OrderEditChange = {
    lines: Object.entries(targets)
      .filter(([, value]) => value.trim() !== '')
      .map(([lineItemId, value]) => ({
        lineItemId,
        quantity: Number(value),
      })),
    restock,
  };
  const valid = change.lines.every(
    (line) => Number.isSafeInteger(line.quantity) && line.quantity >= 0,
  );
  const changed = change.lines.filter(
    (line) =>
      snapshot?.lines.find((item) => item.id === line.lineItemId)
        ?.currentQuantity !== line.quantity,
  );
  const reduces = changed.some(
    (line) =>
      (snapshot?.lines.find((item) => item.id === line.lineItemId)
        ?.currentQuantity ?? 0) > line.quantity,
  );
  const blocker =
    snapshot && data && changed.length && valid
      ? orderEditBlockerReason(
          snapshot,
          { lines: changed, restock },
          { connectionId, granted: data.granted, authority: data.authority },
        )
      : null;

  async function command(
    name: 'preview' | 'execute' | 'approve' | 'check',
    outcome?: 'approved' | 'rejected',
  ) {
    if (pending) return;
    const current = generation.current;
    setPending(true);
    setError('');
    try {
      requestId.current ??= crypto.randomUUID();
      const value = await services.request(
        `order-edit-${name}`,
        name === 'preview'
          ? {
              connectionId,
              orderId,
              requestId: requestId.current,
              change: { lines: changed, restock: restock && reduces },
            }
          : { id: review!.id, ...(outcome ? { outcome } : {}) },
      );
      if (current === generation.current) setReview(orderEditView.parse(value));
    } catch (reason) {
      if (current === generation.current) {
        if (name === 'preview') requestId.current = null;
        // Only a send can leave an unknown outcome; other refusals keep their reason.
        setError(
          name === 'execute' && services.uncertain(reason)
            ? m.shopify_order_edit_interrupted()
            : services.error(reason),
        );
      }
    } finally {
      if (current === generation.current) setPending(false);
    }
  }

  if (!open)
    return (
      <section
        className="shopify-order-edit"
        aria-label={m.shopify_order_edit_title()}
      >
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {m.shopify_order_edit_open()}
        </Button>
      </section>
    );

  return (
    <section
      className="shopify-order-edit"
      aria-label={m.shopify_order_edit_title()}
      aria-busy={pending}
    >
      <div className="shopify-order-edit-heading">
        <div>
          <Heading>{m.shopify_order_edit_title()}</Heading>
          <p className="field-help">{m.shopify_order_edit_help()}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {m.common_refresh()}
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {pending ? <p role="status">{m.shopify_order_edit_checking()}</p> : null}
      {snapshot && data ? (
        <>
          <p className="field-help">
            {m.shopify_order_edit_read_at({
              time: formatTime(snapshot.observedAt),
            })}
          </p>
          {review ? (
            <OrderEditReview
              review={review}
              pending={pending}
              command={command}
              another={() => {
                compose.current = true;
                setRefresh((value) => value + 1);
              }}
            />
          ) : (
            <form
              className="shopify-order-edit-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (changed.length && valid && !blocker)
                  void command('preview');
              }}
            >
              <table className="shopify-order-edit-lines">
                <caption className="sr-only">
                  {m.shopify_order_edit_lines_label()}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{m.shopify_order_edit_column_line()}</th>
                    <th scope="col">{m.shopify_order_edit_column_current()}</th>
                    <th scope="col">
                      {m.shopify_order_edit_column_unfulfilled()}
                    </th>
                    <th scope="col">{m.shopify_order_edit_column_new()}</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.lines.map((line) => {
                    const locked = lineBlockerReason(snapshot, line.id);
                    const hint = `${id}-${line.id.split('/').at(-1)}`;

                    return (
                      <tr key={line.id}>
                        <th scope="row">
                          <span>{line.name}</span>
                          {line.sku ? (
                            <span className="shopify-source-id">
                              {line.sku}
                            </span>
                          ) : null}
                        </th>
                        <td data-label={m.shopify_order_edit_column_current()}>
                          {line.currentQuantity}
                        </td>
                        <td
                          data-label={m.shopify_order_edit_column_unfulfilled()}
                        >
                          {line.unfulfilledQuantity}
                        </td>
                        <td>
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            step={1}
                            className="shopify-order-edit-quantity"
                            aria-label={m.shopify_order_edit_quantity_label({
                              line: line.name,
                            })}
                            aria-describedby={locked ? hint : undefined}
                            placeholder={String(line.currentQuantity)}
                            value={targets[line.id] ?? ''}
                            disabled={pending || !!locked}
                            onChange={(event) => {
                              requestId.current = null;
                              setTargets({
                                ...targets,
                                [line.id]: event.target.value,
                              });
                            }}
                          />
                          {locked ? (
                            <span id={hint} className="field-help">
                              {blockerText[locked]()}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <label className="shopify-order-edit-restock">
                <input
                  type="checkbox"
                  checked={restock}
                  disabled={pending || !reduces}
                  onChange={(event) => {
                    requestId.current = null;
                    setRestock(event.target.checked);
                  }}
                />
                <span>
                  {m.shopify_order_edit_restock()}
                  <span className="field-help">
                    {' '}
                    {m.shopify_order_edit_restock_help()}
                  </span>
                </span>
              </label>
              {data.observeOnly ? (
                <p className="field-help">
                  {m.shopify_order_edit_observe_only()}
                </p>
              ) : null}
              {changed.length &&
              editTouchesHold(snapshot, { lines: changed, restock }) ? (
                <p className="field-help">{m.shopify_order_edit_on_hold()}</p>
              ) : null}
              <p role="status" className="field-help">
                {!changed.length
                  ? m.shopify_order_edit_no_change()
                  : blocker
                    ? blockerText[blocker]()
                    : ''}
              </p>
              <Button
                type="submit"
                variant="outline"
                disabled={pending || !changed.length || !valid || !!blocker}
              >
                {m.shopify_order_edit_preview()}
              </Button>
            </form>
          )}
        </>
      ) : null}
    </section>
  );
}

/** One saved edit with its exact lines, Shopify's calculation, authority and lifecycle stages. */
export function OrderEditReview({
  review,
  pending,
  command,
  another,
}: {
  review: OrderEditView;
  pending: boolean;
  command(
    name: 'execute' | 'approve' | 'check',
    outcome?: 'approved' | 'rejected',
  ): Promise<void>;
  another(): void;
}) {
  const names = new Map(
    review.before.lines.map((line) => [line.id, line.name]),
  );
  const reduces = review.lines.some(
    (line) => line.quantity < line.currentQuantity,
  );
  const calculation = review.calculation;
  const approval: [OperationalState, string] =
    review.state === 'approval_required' && !review.approved
      ? ['approval', m.shopify_order_edit_stage_awaiting()]
      : review.approved || review.acceptance !== 'not_sent'
        ? ['idle', m.shopify_order_edit_stage_approved()]
        : review.state === 'denied'
          ? ['attention', m.shopify_order_edit_stage_stopped()]
          : ['waiting', m.shopify_order_edit_stage_review()];
  const sending: [OperationalState, string] = review.observeOnly
    ? ['idle', m.shopify_order_edit_stage_not_executed()]
    : review.denial === 'withheld'
      ? ['attention', m.shopify_order_edit_stage_withheld()]
      : review.denial === 'not_applied'
        ? ['attention', m.shopify_order_edit_stage_not_applied()]
        : review.acceptance === 'accepted'
          ? ['idle', m.shopify_order_edit_stage_accepted()]
          : review.acceptance === 'unknown'
            ? ['attention', m.shopify_order_edit_stage_sent_unknown()]
            : ['waiting', m.shopify_order_edit_stage_not_sent()];

  return (
    <div className="shopify-order-edit-review" aria-live="polite">
      <strong>
        {m.shopify_order_edit_describe({ count: review.lines.length })}
      </strong>
      <ul className="shopify-order-edit-changes">
        {review.lines.map((line) => (
          <li key={line.lineItemId}>
            {m.shopify_order_edit_line_change({
              line: names.get(line.lineItemId) ?? line.lineItemId,
              from: String(line.currentQuantity),
              to: String(line.quantity),
            })}
          </li>
        ))}
      </ul>
      {reduces ? (
        <p>
          {review.change.restock
            ? m.shopify_order_edit_restocked()
            : m.shopify_order_edit_not_restocked()}
        </p>
      ) : null}
      {review.onHold ? (
        <p className="field-help">{m.shopify_order_edit_on_hold()}</p>
      ) : null}
      <table className="shopify-order-edit-totals">
        <caption>{m.shopify_order_edit_totals()}</caption>
        <thead>
          <tr>
            <td />
            <th scope="col">{m.shopify_order_edit_totals_now()}</th>
            <th scope="col">{m.shopify_order_edit_totals_after()}</th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              ['subtotal', m.shopify_order_edit_subtotal],
              ['total', m.shopify_order_edit_total],
              ['outstanding', m.shopify_order_edit_outstanding],
            ] as const
          ).map(([key, label]) => (
            <tr key={key}>
              <th scope="row">{label()}</th>
              <td>
                <Amount value={review.before.totals[key]} />
              </td>
              <td>
                {calculation ? (
                  <Amount value={calculation[key]} />
                ) : (
                  m.common_not_available()
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="field-help">
        {calculation
          ? m.shopify_order_edit_calculated_by_shopify()
          : m.shopify_order_edit_not_calculated()}
      </p>
      <p className="field-help">
        {m.shopify_order_edit_authority({
          revision: String(review.authority.revision),
        })}
      </p>
      <ol className="shopify-order-edit-stages">
        <li>
          <StatePill state={approval[0]}>{approval[1]}</StatePill>
        </li>
        <li>
          <StatePill state={sending[0]}>{sending[1]}</StatePill>
        </li>
        <li>
          <StatePill
            state={review.state === 'verified' ? 'verified' : 'waiting'}
          >
            {review.state === 'verified'
              ? m.shopify_order_edit_stage_verified()
              : m.shopify_order_edit_stage_not_verified()}
          </StatePill>
        </li>
      </ol>
      <p>{message(review)}</p>
      {review.acceptance === 'not_sent' && review.state !== 'denied' ? (
        <p className="field-help">
          {m.shopify_order_edit_expires({
            time: formatTime(review.expiresAt),
          })}
        </p>
      ) : null}
      <div className="shopify-order-edit-controls">
        {review.canApprove ? (
          <>
            <Button
              disabled={pending}
              onClick={() => void command('approve', 'approved')}
            >
              {m.shopify_order_edit_approve()}
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void command('approve', 'rejected')}
            >
              {m.shopify_order_edit_reject()}
            </Button>
          </>
        ) : null}
        {review.canExecute ? (
          <Button disabled={pending} onClick={() => void command('execute')}>
            {m.shopify_order_edit_send()}
          </Button>
        ) : null}
        {review.state !== 'verified' &&
        !(review.state === 'denied' && review.acceptance === 'not_sent') ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void command('check')}
          >
            {review.acceptance === 'not_sent'
              ? m.shopify_order_edit_check_approval()
              : m.shopify_order_edit_check_outcome()}
          </Button>
        ) : null}
        {['denied', 'verified', 'recovery_required'].includes(review.state) ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={another}
          >
            {m.shopify_order_edit_review_another()}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
