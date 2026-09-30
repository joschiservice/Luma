import './fulfillment-recovery.css';

import type { AppUiProps } from '@luma/app-host/web';
import { Button } from '@luma/ui/components/primitives/button';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod/v3';

import {
  recoveryBlocker,
  type RecoveryChoice,
  recoverySnapshot,
  type RecoveryView,
  recoveryView,
} from '../domain/fulfillment-recovery.js';

const inspection = z.object({
  snapshot: recoverySnapshot,
  granted: z.array(z.string()),
  runs: z.array(recoveryView),
});

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
                message:
                  'This preview expired. Refresh fulfillment details and review a new action.',
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
            ? 'The response was interrupted. Refresh to check the saved recovery before trying again.'
            : services.error(reason),
        );
    } finally {
      if (current === generation.current) setPending(false);
    }
  }

  const snapshot = data?.snapshot;
  const blocker =
    snapshot && data ? recoveryBlocker(snapshot, choice, data.granted) : null;

  return (
    <section
      className="shopify-recovery"
      aria-label="Fulfillment recovery"
      aria-busy={pending}
    >
      <div className="shopify-recovery-heading">
        <div>
          <Heading>Fulfillment recovery</Heading>
          <p className="field-help">
            Review a precise change, then verify what happened.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh recovery
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {pending ? <p role="status">Checking recovery…</p> : null}
      {snapshot ? (
        <>
          <div className="shopify-recovery-facts">
            <StatePill
              state={snapshot.status === 'ON_HOLD' ? 'attention' : 'idle'}
            >
              {snapshot.status.replaceAll('_', ' ').toLowerCase()}
            </StatePill>
            <span>{snapshot.locationName}</span>
            <span className="field-help">
              Read {new Date(snapshot.observedAt).toLocaleTimeString()}
            </span>
          </div>
          <p className="shopify-source-id">{fulfillmentOrderId}</p>
          {data && data.runs.length > 1 ? (
            <label>
              Saved recoveries
              <Select
                aria-label="Saved recoveries"
                value={review?.id ?? null}
                options={data.runs.map((run) => ({
                  value: run.id,
                  label: `${run.choice.capability === 'fulfillment.hold.release' ? 'Release hold' : run.choice.capability === 'fulfillment.move' ? 'Move fulfillment' : 'Reopen fulfillment'} · ${new Date(run.before.observedAt).toLocaleTimeString()}`,
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
                Recovery action
                <Select
                  aria-label="Recovery action"
                  value={choice.capability}
                  options={[
                    {
                      value: 'fulfillment.hold.release',
                      label: 'Release one hold',
                    },
                    { value: 'fulfillment.open', label: 'Reopen fulfillment' },
                    {
                      value: 'fulfillment.move',
                      label: 'Move remaining items',
                    },
                  ]}
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
                  Hold to release
                  <Select
                    aria-label="Hold to release"
                    value={choice.holdId || null}
                    placeholder="No holds available"
                    options={snapshot.holds.map((hold) => ({
                      value: hold.id,
                      label: `${hold.reason.replaceAll('_', ' ').toLowerCase()} · ${hold.id.split('/').at(-1)}`,
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
                    Only this hold will be released. Other holds stay in place.
                  </span>
                </label>
              ) : null}
              {choice.capability === 'fulfillment.move' ? (
                <label>
                  Destination
                  <Select
                    aria-label="Destination"
                    value={choice.locationId || null}
                    placeholder="No eligible locations"
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
                    Move all remaining items. Already fulfilled items stay at
                    their original location.
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
                Preview recovery
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
              Review another action
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
      ? `Release hold ${choice.holdId.split('/').at(-1)} only`
      : choice.capability === 'fulfillment.move'
        ? `Move remaining items to ${review.before.locations.find((location) => location.id === choice.locationId)?.name ?? choice.locationId}`
        : 'Mark this fulfillment order as open';

  return (
    <div className="shopify-recovery-review" aria-live="polite">
      <strong>{description}</strong>
      <ol className="shopify-recovery-stages">
        <li>
          <StatePill
            state={review.state === 'approval_required' ? 'approval' : 'idle'}
          >
            Review & approval
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
              ? 'Shopify accepted'
              : review.acceptance === 'unknown'
                ? 'Acceptance uncertain'
                : 'Not sent to Shopify'}
          </StatePill>
        </li>
        <li>
          <StatePill
            state={review.state === 'verified' ? 'verified' : 'waiting'}
          >
            {review.state === 'verified'
              ? 'Progress verified'
              : 'Progress not verified'}
          </StatePill>
        </li>
      </ol>
      <p>{review.message}</p>
      {review.acceptance === 'not_sent' ? (
        <p className="field-help">
          Preview expires {new Date(review.expiresAt).toLocaleTimeString()}.
          Changes in Shopify require a fresh review.
        </p>
      ) : null}
      <div className="shopify-recovery-controls">
        {review.canApprove ? (
          <>
            <Button
              disabled={pending}
              onClick={() => void command('approve', 'approved')}
            >
              Approve action
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void command('approve', 'rejected')}
            >
              Reject
            </Button>
          </>
        ) : null}
        {review.canExecute ? (
          <Button disabled={pending} onClick={() => void command('execute')}>
            Run approved action
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => void command('check')}
        >
          {review.acceptance === 'not_sent'
            ? 'Check approval'
            : 'Check fulfillment progress'}
        </Button>
      </div>
    </div>
  );
}
