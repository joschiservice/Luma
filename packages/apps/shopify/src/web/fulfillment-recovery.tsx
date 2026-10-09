import './fulfillment-recovery.css';

import type { AppUiProps } from '@luma/app-host/web';
import { formatTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import {
  type RecoveryBlockerReason,
  recoveryBlockerReason,
  type RecoveryChoice,
  recoverySnapshot,
  type RecoveryView,
  recoveryView,
} from '../domain/fulfillment-recovery.js';

const recoveryBlockerText: Record<RecoveryBlockerReason, () => string> = {
  write_access: m.shopify_blocker_recovery_write_access,
  incomplete: m.shopify_blocker_recovery_incomplete,
  closed: m.shopify_blocker_recovery_closed,
  not_allowed: m.shopify_blocker_recovery_not_allowed,
  hold_gone: m.shopify_blocker_recovery_hold_gone,
  cancellation_pending: m.shopify_blocker_recovery_cancellation_pending,
  same_location: m.shopify_blocker_recovery_same_location,
  location_unavailable: m.shopify_blocker_recovery_location_unavailable,
};

const inspection = z.object({
  snapshot: recoverySnapshot,
  granted: z.array(z.string()),
  runs: z.array(recoveryView),
});

const actionLabels = {
  'fulfillment.hold.release': m.shopify_recovery_action_release,
  'fulfillment.open': m.shopify_recovery_action_open,
  'fulfillment.move': m.shopify_recovery_action_move,
} satisfies Record<RecoveryChoice['capability'], () => string>;

const statusLabels: Record<string, () => string> = {
  OPEN: m.shopify_fulfillment_status_open,
  ON_HOLD: m.shopify_fulfillment_status_on_hold,
  IN_PROGRESS: m.shopify_fulfillment_status_in_progress,
  SCHEDULED: m.shopify_fulfillment_status_scheduled,
  INCOMPLETE: m.shopify_fulfillment_status_incomplete,
  CLOSED: m.shopify_fulfillment_status_closed,
  CANCELLED: m.shopify_fulfillment_status_cancelled,
};

const holdReasons: Record<string, () => string> = {
  AWAITING_PAYMENT: m.shopify_hold_reason_awaiting_payment,
  AWAITING_RETURN_ITEMS: m.shopify_hold_reason_awaiting_return_items,
  HIGH_RISK_OF_FRAUD: m.shopify_hold_reason_high_risk_of_fraud,
  INCORRECT_ADDRESS: m.shopify_hold_reason_incorrect_address,
  INVENTORY_OUT_OF_STOCK: m.shopify_hold_reason_inventory_out_of_stock,
  ONLINE_STORE_POST_PURCHASE_CROSS_SELL:
    m.shopify_hold_reason_online_store_post_purchase_cross_sell,
  UNKNOWN_DELIVERY_DATE: m.shopify_hold_reason_unknown_delivery_date,
  OTHER: m.shopify_hold_reason_other,
};

/** Names a Shopify enum value in the reader's language, falling back to Shopify's own wording. */
function shopifyLabel(labels: Record<string, () => string>, value: string) {
  return labels[value]?.() ?? value.replaceAll('_', ' ').toLowerCase();
}

/** Shows a live recovery review with exact targets, separate approval and independent progress checks. */
export function ShopifyFulfillmentRecovery({
  connectionId,
  orderId,
  fulfillmentOrderId,
  services,
  headingLevel = 2,
}: {
  connectionId: string;
  orderId: string;
  fulfillmentOrderId: string;
  services: AppUiProps['services'];
  headingLevel?: 2 | 3 | 4;
}) {
  const Heading = `h${headingLevel}` as const;
  const [data, setData] = useState<z.infer<typeof inspection> | null>(null);
  const [choice, setChoice] = useState<RecoveryChoice>({
    capability: 'fulfillment.open',
  });
  const [review, setReview] = useState<RecoveryView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const requestId = useRef<string | null>(null);
  const generation = useRef(0);
  const composeAfterRefresh = useRef(false);
  const target = { connectionId, orderId, fulfillmentOrderId };
  useEffect(() => {
    const current = ++generation.current;
    setPending(true);
    setData(null);
    setReview(null);
    setError('');
    requestId.current = null;
    services
      .request('fulfillment-recovery-inspect', {
        connectionId,
        orderId,
        fulfillmentOrderId,
      })
      .then((result) => {
        if (current !== generation.current) return;
        const value = inspection.parse(result);
        setData(value);
        setReview(composeAfterRefresh.current ? null : (value.runs[0] ?? null));
        composeAfterRefresh.current = false;
        const hold = value.snapshot.holds[0];
        setChoice(
          hold
            ? { capability: 'fulfillment.hold.release', holdId: hold.id }
            : { capability: 'fulfillment.open' },
        );
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
  }, [connectionId, orderId, fulfillmentOrderId, services, refresh]);

  useEffect(() => {
    if (!review || review.acceptance !== 'not_sent') return;
    const id = review.id;
    const timer = window.setTimeout(
      () => {
        setReview((current) =>
          current?.id === id && current.acceptance === 'not_sent'
            ? {
                ...current,
                state: 'denied',
                canExecute: false,
                canApprove: false,
                message: m.shopify_recovery_expired(),
              }
            : current,
        );
      },
      Math.max(0, Date.parse(review.expiresAt) - Date.now()),
    );

    return () => window.clearTimeout(timer);
  }, [review]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible' && !pending)
        setRefresh((value) => value + 1);
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () =>
      document.removeEventListener('visibilitychange', refreshWhenVisible);
  }, [pending]);

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
        `fulfillment-recovery-${name}`,
        name === 'preview'
          ? { ...target, choice, requestId: requestId.current }
          : { id: review!.id, ...(outcome ? { outcome } : {}) },
      );
      if (current === generation.current) setReview(recoveryView.parse(value));
    } catch (reason) {
      if (current === generation.current)
        setError(
          services.uncertain(reason)
            ? m.shopify_recovery_interrupted()
            : services.error(reason),
        );
    } finally {
      if (current === generation.current) setPending(false);
    }
  }

  const snapshot = data?.snapshot;
  const blockerReason =
    snapshot && data
      ? recoveryBlockerReason(snapshot, choice, data.granted)
      : null;
  const blocker = blockerReason ? recoveryBlockerText[blockerReason]() : null;

  return (
    <section
      className="shopify-recovery"
      aria-label={m.shopify_recovery_title()}
      aria-busy={pending}
    >
      <div className="shopify-recovery-heading">
        <div>
          <Heading>{m.shopify_recovery_title()}</Heading>
          <p className="field-help">{m.shopify_recovery_help()}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {m.shopify_recovery_refresh()}
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {pending ? <p role="status">{m.shopify_recovery_checking()}</p> : null}
      {snapshot ? (
        <>
          <div className="shopify-recovery-facts">
            <StatePill
              state={snapshot.status === 'ON_HOLD' ? 'attention' : 'idle'}
            >
              {shopifyLabel(statusLabels, snapshot.status)}
            </StatePill>
            <span>{snapshot.locationName}</span>
            <span className="field-help">
              {m.shopify_recovery_read_at({
                time: formatTime(snapshot.observedAt),
              })}
            </span>
          </div>
          <p className="shopify-source-id">{fulfillmentOrderId}</p>
          {data && data.runs.length > 1 ? (
            <label>
              {m.shopify_recovery_saved_label()}
              <Select
                aria-label={m.shopify_recovery_saved_label()}
                value={review?.id ?? null}
                options={data.runs.map((run) => ({
                  value: run.id,
                  label: m.shopify_recovery_saved_option({
                    action: actionLabels[run.choice.capability](),
                    time: formatTime(run.before.observedAt),
                  }),
                }))}
                onValueChange={(id) =>
                  setReview(data.runs.find((run) => run.id === id) ?? null)
                }
                disabled={pending}
              />
            </label>
          ) : null}
          {review ? (
            <RecoveryReview
              review={review}
              pending={pending}
              command={command}
            />
          ) : (
            <>
              <label>
                {m.shopify_recovery_action_label()}
                <Select
                  aria-label={m.shopify_recovery_action_label()}
                  value={choice.capability}
                  options={(
                    [
                      'fulfillment.hold.release',
                      'fulfillment.open',
                      'fulfillment.move',
                    ] as const
                  ).map((value) => ({ value, label: actionLabels[value]() }))}
                  onValueChange={(value) => {
                    requestId.current = null;
                    if (value === 'fulfillment.hold.release')
                      setChoice({
                        capability: value,
                        holdId: snapshot.holds[0]?.id ?? '',
                      });
                    else if (value === 'fulfillment.move')
                      setChoice({
                        capability: value,
                        locationId:
                          snapshot.locations.find(
                            (location) => location.movable,
                          )?.id ?? '',
                      });
                    else if (value === 'fulfillment.open')
                      setChoice({ capability: value });
                  }}
                  disabled={pending}
                />
              </label>
              {choice.capability === 'fulfillment.hold.release' ? (
                <label>
                  {m.shopify_recovery_hold_label()}
                  <Select
                    aria-label={m.shopify_recovery_hold_label()}
                    value={choice.holdId || null}
                    placeholder={m.shopify_recovery_hold_none()}
                    options={snapshot.holds.map((hold) => ({
                      value: hold.id,
                      label: m.shopify_recovery_hold_option({
                        reason: shopifyLabel(holdReasons, hold.reason),
                        hold: hold.id.split('/').at(-1) ?? hold.id,
                      }),
                    }))}
                    onValueChange={(holdId) => {
                      if (holdId) {
                        requestId.current = null;
                        setChoice({
                          capability: 'fulfillment.hold.release',
                          holdId,
                        });
                      }
                    }}
                    disabled={pending}
                  />
                  <span className="field-help">
                    {m.shopify_recovery_hold_help()}
                  </span>
                </label>
              ) : null}
              {choice.capability === 'fulfillment.move' ? (
                <label>
                  {m.shopify_recovery_destination_label()}
                  <Select
                    aria-label={m.shopify_recovery_destination_label()}
                    value={choice.locationId || null}
                    placeholder={m.shopify_recovery_destination_none()}
                    options={snapshot.locations.map((location) => ({
                      value: location.id,
                      label: location.name,
                      disabled:
                        !location.movable ||
                        location.id === snapshot.locationId,
                    }))}
                    onValueChange={(locationId) => {
                      if (locationId) {
                        requestId.current = null;
                        setChoice({
                          capability: 'fulfillment.move',
                          locationId,
                        });
                      }
                    }}
                    disabled={pending}
                  />
                  <span className="field-help">
                    {m.shopify_recovery_destination_help()}
                  </span>
                </label>
              ) : null}
              {blocker ? (
                <p role="status" className="field-help">
                  {blocker}
                </p>
              ) : null}
              <Button
                variant="outline"
                disabled={pending || !!blocker}
                onClick={() => void command('preview')}
              >
                {m.shopify_recovery_preview()}
              </Button>
            </>
          )}
          {review &&
          ['denied', 'verified', 'recovery_required'].includes(review.state) ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                composeAfterRefresh.current = true;
                setRefresh((value) => value + 1);
              }}
            >
              {m.shopify_recovery_review_another()}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function RecoveryReview({
  review,
  pending,
  command,
}: {
  review: RecoveryView;
  pending: boolean;
  command(
    name: 'execute' | 'approve' | 'check',
    outcome?: 'approved' | 'rejected',
  ): Promise<void>;
}) {
  const choice = review.choice;
  const description =
    choice.capability === 'fulfillment.hold.release'
      ? m.shopify_recovery_describe_release({
          hold: choice.holdId.split('/').at(-1) ?? choice.holdId,
        })
      : choice.capability === 'fulfillment.move'
        ? m.shopify_recovery_describe_move({
            location:
              review.before.locations.find(
                (location) => location.id === choice.locationId,
              )?.name ?? choice.locationId,
          })
        : m.shopify_recovery_describe_open();

  return (
    <div className="shopify-recovery-review" aria-live="polite">
      <strong>{description}</strong>
      <ol className="shopify-recovery-stages">
        <li>
          <StatePill
            state={review.state === 'approval_required' ? 'approval' : 'idle'}
          >
            {m.shopify_recovery_stage_review()}
          </StatePill>
        </li>
        <li>
          <StatePill
            state={
              review.acceptance === 'accepted'
                ? 'idle'
                : review.acceptance === 'unknown'
                  ? 'attention'
                  : 'waiting'
            }
          >
            {review.acceptance === 'accepted'
              ? m.shopify_recovery_stage_accepted()
              : review.acceptance === 'unknown'
                ? m.shopify_recovery_stage_unclear()
                : m.shopify_recovery_stage_not_sent()}
          </StatePill>
        </li>
        <li>
          <StatePill
            state={review.state === 'verified' ? 'verified' : 'waiting'}
          >
            {review.state === 'verified'
              ? m.shopify_recovery_stage_verified()
              : m.shopify_recovery_stage_not_verified()}
          </StatePill>
        </li>
      </ol>
      <p>{review.message}</p>
      {review.acceptance === 'not_sent' ? (
        <p className="field-help">
          {m.shopify_recovery_expires({ time: formatTime(review.expiresAt) })}
        </p>
      ) : null}
      <div className="shopify-recovery-controls">
        {review.canApprove ? (
          <>
            <Button
              disabled={pending}
              onClick={() => void command('approve', 'approved')}
            >
              {m.shopify_recovery_approve()}
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void command('approve', 'rejected')}
            >
              {m.shopify_recovery_reject()}
            </Button>
          </>
        ) : null}
        {review.canExecute ? (
          <Button disabled={pending} onClick={() => void command('execute')}>
            {m.shopify_recovery_send()}
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => void command('check')}
        >
          {review.acceptance === 'not_sent'
            ? m.shopify_recovery_check_approval()
            : m.shopify_recovery_check_progress()}
        </Button>
      </div>
    </div>
  );
}
