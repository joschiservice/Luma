import './fulfillment-recovery.css';

import type { AppUiProps } from '@luma/app-host/web';
import { formatDateTime, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Switch } from '@luma/ui/components/primitives/switch';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import {
  publishingBlocker,
  type PublishingChoice,
  publishingSnapshot,
  type PublishingView,
  publishingView,
} from '../domain/shipment-publishing.js';

const sourceOptions = z.object({
  enabled: z.boolean(),
  sources: z.array(
    z.object({
      downstreamConnectionId: z.string().uuid(),
      shipmentId: z.string(),
      label: z.string(),
    }),
  ),
});
const inspection = z.object({
  snapshot: publishingSnapshot,
  granted: z.array(z.string()),
  runs: z.array(publishingView),
});
const tail = (id: string) => id.split('/').at(-1) ?? id;
const messages = {
  preview: m.shopify_publishing_state_preview,
  approval_required: m.shopify_publishing_state_approval_required,
  denied: m.shopify_publishing_state_denied,
  uncertain: m.shopify_publishing_state_uncertain,
  verified: m.shopify_publishing_state_verified,
  accepted: m.shopify_publishing_state_accepted,
  recovery_required: m.shopify_publishing_state_accepted,
};

/** Reviews exact parcel allocations, notification choices, approval and independently verified publication. */
export function ShopifyShipmentPublishing({
  connectionId,
  orderId,
  services,
}: {
  connectionId: string;
  orderId: string;
  services: AppUiProps['services'];
}) {
  const [options, setOptions] = useState<z.infer<typeof sourceOptions> | null>(
    null,
  );
  const [selected, setSelected] = useState('');
  const [data, setData] = useState<z.infer<typeof inspection> | null>(null);
  const [operation, setOperation] = useState<
    'fulfillment.shipment.create' | 'fulfillment.tracking.update'
  >('fulfillment.shipment.create');
  const [workId, setWorkId] = useState(''),
    [shipmentId, setShipmentId] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false),
    [notify, setNotify] = useState(false);
  const [review, setReview] = useState<PublishingView | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  const requestId = useRef<string | null>(null),
    lock = useRef(false);
  useEffect(() => {
    let active = true;
    setPending(true);
    setError('');
    services
      .request('shipment-publishing-sources', { connectionId, orderId })
      .then((result) => {
        if (!active) return;
        const value = sourceOptions.parse(result);
        setOptions(value);
        setSelected((current) =>
          value.sources.some(
            (s) => `${s.downstreamConnectionId}:${s.shipmentId}` === current,
          )
            ? current
            : value.sources[0]
              ? `${value.sources[0].downstreamConnectionId}:${value.sources[0].shipmentId}`
              : '',
        );
      })
      .catch((e) => {
        if (active) setError(services.error(e));
      })
      .finally(() => {
        if (active) setPending(false);
      });

    return () => {
      active = false;
    };
  }, [connectionId, orderId, services, refresh]);
  const source = options?.sources.find(
    (s) => `${s.downstreamConnectionId}:${s.shipmentId}` === selected,
  );
  useEffect(() => {
    if (!source) return;
    let active = true;
    setPending(true);
    setData(null);
    setReview(null);
    setError('');
    setConfirmed(false);
    requestId.current = null;
    services
      .request('shipment-publishing-inspect', {
        connectionId,
        orderId,
        source: {
          downstreamConnectionId: source.downstreamConnectionId,
          shipmentId: source.shipmentId,
        },
      })
      .then((result) => {
        if (!active) return;
        const value = inspection.parse(result);
        setData(value);
        setReview(
          value.runs.find(
            (r) =>
              r.choice.source.shipmentId === source.shipmentId &&
              r.choice.source.downstreamConnectionId ===
                source.downstreamConnectionId,
          ) ?? null,
        );
        setWorkId(
          value.snapshot.work.find(
            (w) => w.status === 'OPEN' || w.status === 'IN_PROGRESS',
          )?.id ?? '',
        );
        setShipmentId(
          value.snapshot.shipments.find((s) => s.status === 'SUCCESS')?.id ??
            '',
        );
        setQuantities({});
      })
      .catch((e) => {
        if (active) setError(services.error(e));
      })
      .finally(() => {
        if (active) setPending(false);
      });

    return () => {
      active = false;
    };
  }, [
    connectionId,
    orderId,
    services,
    source?.downstreamConnectionId,
    source?.shipmentId,
    refresh,
  ]);
  const work = data?.snapshot.work.find((w) => w.id === workId),
    shipment = data?.snapshot.shipments.find((s) => s.id === shipmentId);
  const reviewedChoice = review?.choice;
  const reviewedShipment =
    reviewedChoice?.capability === 'fulfillment.tracking.update'
      ? review?.before.shipments.find(
          (s) => s.id === reviewedChoice.fulfillmentId,
        )
      : undefined;
  const eligibleWork =
    data?.snapshot.work.filter((w) =>
      ['OPEN', 'IN_PROGRESS'].includes(w.status),
    ) ?? [];
  const selectedLines = eligibleWork
    .filter((w) => w.locationId === work?.locationId)
    .flatMap((work) => work.lines.map((line) => ({ work, line })));
  const operator =
    data?.snapshot.dispatch &&
    (!data.snapshot.dispatch.lines.length ||
      !data.snapshot.dispatch.locationId);
  const choice: PublishingChoice | null =
    source && data
      ? operation === 'fulfillment.shipment.create'
        ? {
            capability: operation,
            source: {
              downstreamConnectionId: source.downstreamConnectionId,
              shipmentId: source.shipmentId,
            },
            notifyCustomer: notify,
            allocationSource: operator ? 'operator' : 'provider',
            allocations: selectedLines.flatMap(({ work, line }) => {
              const quantity = Number(quantities[line.id] ?? 0);

              return Number.isSafeInteger(quantity) &&
                quantity > 0 &&
                work?.locationId
                ? [
                    {
                      fulfillmentOrderId: work.id,
                      fulfillmentOrderLineId: line.id,
                      orderLineId: line.orderLineId,
                      locationId: work.locationId,
                      quantity,
                    },
                  ]
                : [];
            }),
          }
        : {
            capability: operation,
            source: {
              downstreamConnectionId: source.downstreamConnectionId,
              shipmentId: source.shipmentId,
            },
            fulfillmentId: shipmentId,
            notifyCustomer: notify,
            allocationSource: operator ? 'operator' : 'provider',
            ...(operator && shipment?.locationId
              ? {
                  confirmedAllocation: {
                    locationId: shipment.locationId,
                    lines: shipment.lines,
                  },
                }
              : {}),
          }
      : null;
  const blocked =
    !choice ||
    !data ||
    !data.snapshot.dispatch ||
    !!publishingBlocker(data.snapshot, choice, data.granted) ||
    (operator && !confirmed) ||
    (choice.capability === 'fulfillment.shipment.create' &&
      !choice.allocations.length);

  function changed() {
    requestId.current = null;
    setReview(null);
  }

  async function command(
    name: 'preview' | 'execute' | 'approve' | 'check',
    outcome?: 'approved' | 'rejected',
  ) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError('');
    try {
      const input =
        name === 'preview'
          ? {
              connectionId,
              orderId,
              requestId: (requestId.current ??= crypto.randomUUID()),
              choice,
            }
          : name === 'approve'
            ? { id: review?.id, outcome }
            : { id: review?.id };
      setReview(
        publishingView.parse(
          await services.request(`shipment-publishing-${name}`, input),
        ),
      );
    } catch (e) {
      setError(services.error(e));
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  async function reviewAnother() {
    if (lock.current || !source) return;
    lock.current = true;
    setPending(true);
    setError('');
    try {
      const current = inspection.parse(
        await services.request('shipment-publishing-inspect', {
          connectionId,
          orderId,
          source: {
            downstreamConnectionId: source.downstreamConnectionId,
            shipmentId: source.shipmentId,
          },
        }),
      );
      setData(current);
      setWorkId(
        current.snapshot.work.find((w) =>
          ['OPEN', 'IN_PROGRESS'].includes(w.status),
        )?.id ?? '',
      );
      setShipmentId(
        current.snapshot.shipments.find((s) => s.status === 'SUCCESS')?.id ??
          '',
      );
      setQuantities({});
      setNotify(false);
      setConfirmed(false);
      requestId.current = null;
      setReview(null);
    } catch (e) {
      setError(services.error(e));
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  return (
    <section className="shopify-recovery" aria-busy={pending}>
      <div className="shopify-recovery-heading">
        <h3>{m.shopify_publishing_title()}</h3>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => setRefresh((v) => v + 1)}
        >
          {m.shopify_publishing_refresh()}
        </Button>
      </div>
      <p>{m.shopify_publishing_help()}</p>
      {pending ? <p role="status">{m.shopify_publishing_loading()}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {options && !options.enabled ? (
        <p>{m.shopify_publishing_disabled()}</p>
      ) : options && !options.sources.length ? (
        <p>{m.shopify_publishing_empty()}</p>
      ) : null}
      {options?.enabled && options.sources.length ? (
        <label>
          {m.shopify_publishing_source()}
          <Select
            aria-label={m.shopify_publishing_source()}
            value={selected}
            options={options.sources.map((s) => ({
              value: `${s.downstreamConnectionId}:${s.shipmentId}`,
              label: s.label,
            }))}
            disabled={pending}
            onValueChange={(v) => {
              setSelected(v ?? '');
              changed();
            }}
          />
        </label>
      ) : null}
      {data && options?.enabled && !review ? (
        <>
          <label>
            {m.shopify_publishing_operation()}
            <Select
              aria-label={m.shopify_publishing_operation()}
              value={operation}
              options={[
                {
                  value: 'fulfillment.shipment.create',
                  label: m.shopify_publishing_create(),
                },
                {
                  value: 'fulfillment.tracking.update',
                  label: m.shopify_publishing_tracking(),
                },
              ]}
              disabled={pending}
              onValueChange={(v) => {
                if (v) {
                  setOperation(v);
                  setConfirmed(false);
                  changed();
                }
              }}
            />
          </label>
          {operation === 'fulfillment.shipment.create' ? (
            <>
              <label>
                {m.shopify_publishing_work()}
                <Select
                  aria-label={m.shopify_publishing_work()}
                  value={workId}
                  options={eligibleWork
                    .filter(
                      (w, index) =>
                        eligibleWork.findIndex(
                          (other) => other.locationId === w.locationId,
                        ) === index,
                    )
                    .map((w) => ({
                      value: w.id,
                      label: `${w.locationName || tail(w.locationId ?? '')} · ${eligibleWork
                        .filter((other) => other.locationId === w.locationId)
                        .map((other) => tail(other.id))
                        .join(', ')}`,
                    }))}
                  disabled={pending}
                  onValueChange={(v) => {
                    setWorkId(v ?? '');
                    setQuantities({});
                    setConfirmed(false);
                    changed();
                  }}
                />
              </label>
              {selectedLines.map(({ work: lineWork, line }) => (
                <label key={line.id}>
                  {m.shopify_publishing_quantity({
                    line: `${line.name || tail(line.orderLineId)}${selectedLines.filter((other) => other.line.orderLineId === line.orderLineId).length > 1 ? ` (${tail(lineWork.id)})` : ''}`,
                  })}
                  <Input
                    type="number"
                    min={0}
                    max={line.remaining}
                    step={1}
                    value={quantities[line.id] ?? '0'}
                    disabled={pending}
                    onChange={(e) => {
                      setQuantities((v) => ({
                        ...v,
                        [line.id]: e.target.value,
                      }));
                      setConfirmed(false);
                      changed();
                    }}
                  />
                  <small>
                    {m.shopify_publishing_remaining({
                      quantity: formatNumber(line.remaining),
                    })}
                  </small>
                </label>
              ))}
            </>
          ) : (
            <label>
              {m.shopify_publishing_shipment()}
              <Select
                aria-label={m.shopify_publishing_shipment()}
                value={shipmentId}
                options={data.snapshot.shipments
                  .filter((s) => s.status === 'SUCCESS')
                  .map((s) => ({
                    value: s.id,
                    label: `${tail(s.id)} · ${s.tracking.map((t) => t.number).join(', ')}`,
                  }))}
                disabled={pending}
                onValueChange={(v) => {
                  setShipmentId(v ?? '');
                  setConfirmed(false);
                  changed();
                }}
              />
            </label>
          )}
          {data.snapshot.dispatch?.tracking.map((t) => (
            <p key={t.number}>
              {t.company} · {t.number}
            </p>
          ))}
          {operator ? (
            <>
              <p>{m.shopify_publishing_allocation_help()}</p>
              <label className="shopify-recovery-facts">
                <Switch
                  checked={confirmed}
                  disabled={pending}
                  onCheckedChange={(v) => {
                    setConfirmed(v);
                    changed();
                  }}
                />
                {m.shopify_publishing_confirm()}
              </label>
            </>
          ) : null}
          <label className="shopify-recovery-facts">
            <Switch
              checked={notify}
              disabled={pending}
              onCheckedChange={(v) => {
                setNotify(v);
                changed();
              }}
            />
            {m.shopify_publishing_notify()}
          </label>
          {blocked ? <p>{m.shopify_publishing_ineligible()}</p> : null}
          <Button
            disabled={pending || blocked}
            onClick={() => void command('preview')}
          >
            {m.shopify_publishing_preview()}
          </Button>
        </>
      ) : null}
      {data?.snapshot.dispatch ? (
        <p>
          {m.shopify_publishing_read_at({
            time: formatDateTime(data.snapshot.dispatch.observedAt),
          })}
        </p>
      ) : null}
      {review ? (
        <div className="shopify-recovery-review">
          <h4>{m.shopify_publishing_review()}</h4>
          <p role="status">
            {review.observeOnly
              ? m.shopify_publishing_observe()
              : review.state === 'approval_required' &&
                  (review.approved || review.canExecute)
                ? m.shopify_publishing_state_ready()
                : messages[review.state]()}
          </p>
          <p>
            {review.choice.notifyCustomer
              ? m.shopify_publishing_notify_yes()
              : m.shopify_publishing_notify_no()}
          </p>
          {review.choice.notifyCustomer && review.acceptance === 'unknown' ? (
            <p>{m.shopify_publishing_notification_unknown()}</p>
          ) : null}
          {reviewedShipment?.locationId ? (
            <p>
              {m.shopify_publishing_warehouse({
                location:
                  review.before.work.find(
                    (w) => w.locationId === reviewedShipment.locationId,
                  )?.locationName || tail(reviewedShipment.locationId),
              })}
            </p>
          ) : null}
          {review.choice.capability === 'fulfillment.shipment.create'
            ? review.choice.allocations.map((a) => {
                const work = review.before.work.find(
                  (w) => w.id === a.fulfillmentOrderId,
                );
                const name = work?.lines.find(
                  (l) => l.id === a.fulfillmentOrderLineId,
                )?.name;

                return (
                  <div key={a.fulfillmentOrderLineId}>
                    <p>
                      {m.shopify_publishing_lines({
                        line: name
                          ? `${name} (${tail(a.orderLineId)})`
                          : tail(a.orderLineId),
                        quantity: formatNumber(a.quantity),
                      })}
                    </p>
                    <p>
                      {m.shopify_publishing_warehouse({
                        location: work?.locationName
                          ? `${work.locationName} (${tail(a.locationId)})`
                          : tail(a.locationId),
                      })}
                    </p>
                  </div>
                );
              })
            : reviewedShipment?.lines.map((line) => {
                const work = review.before.work.find((w) =>
                  w.lines.some((l) => l.orderLineId === line.orderLineId),
                );
                const name = work?.lines.find(
                  (l) => l.orderLineId === line.orderLineId,
                )?.name;

                return (
                  <p key={line.orderLineId}>
                    {m.shopify_publishing_lines({
                      line: name
                        ? `${name} (${tail(line.orderLineId)})`
                        : tail(line.orderLineId),
                      quantity: formatNumber(line.quantity),
                    })}
                  </p>
                );
              })}
          {review.before.dispatch?.tracking.map((t) => (
            <p key={t.number}>
              {t.company} · {t.number}
            </p>
          ))}
          <div className="shopify-recovery-controls">
            {review.canApprove ? (
              <>
                <Button
                  disabled={pending}
                  onClick={() => void command('approve', 'approved')}
                >
                  {m.shopify_publishing_approve()}
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => void command('approve', 'rejected')}
                >
                  {m.shopify_publishing_reject()}
                </Button>
              </>
            ) : null}
            {review.canExecute ? (
              <Button
                disabled={pending}
                onClick={() => void command('execute')}
              >
                {m.shopify_publishing_execute()}
              </Button>
            ) : null}
            {['uncertain', 'accepted', 'recovery_required'].includes(
              review.state,
            ) ? (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void command('check')}
              >
                {m.shopify_publishing_check()}
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void reviewAnother()}
            >
              {m.shopify_publishing_new()}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
