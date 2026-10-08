import './inventory-correction.css';

import type { AppUiProps } from '@luma/app-host/web';
import { formatDateTime, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod/v3';

import {
  type CorrectionBlockerReason,
  correctionBlockerReason,
  type CorrectionCandidate,
  correctionCandidate,
  correctionSnapshot,
  type CorrectionView,
  correctionView,
} from '../domain/inventory-correction.js';

const correctionBlockerText: Record<CorrectionBlockerReason, () => string> = {
  write_access: m.shopify_blocker_correction_write_access,
  untracked: m.shopify_blocker_correction_untracked,
  stale: m.shopify_blocker_correction_stale,
  already_matches: m.shopify_blocker_correction_already_matches,
};

const inspection = z.object({
  snapshot: correctionSnapshot,
  granted: z.array(z.string()),
  runs: z.array(correctionView),
});

/** Shows a stock quantity in the reader's language, or Unknown when the system didn't report one. */
function quantity(value: number | null | undefined) {
  return value == null ? m.common_unknown() : formatNumber(value);
}

/** Reviews an ERP-backed Shopify correction and separates approval, acceptance and verified stock. */
export function ShopifyInventoryCorrection({
  positionId,
  services,
}: {
  positionId: string;
  services: AppUiProps['services'];
}) {
  const [candidates, setCandidates] = useState<CorrectionCandidate[] | null>(
    null,
  );
  const [connectionId, setConnectionId] = useState('');
  const [sourceConnectionId, setSourceConnectionId] = useState('');
  const [data, setData] = useState<z.infer<typeof inspection> | null>(null);
  const [review, setReview] = useState<CorrectionView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0),
    lock = useRef(false),
    requestId = useRef<string | null>(null);
  const newReview = useRef(false);
  useEffect(() => {
    let active = true;
    setCandidates(null);
    setError('');
    services
      .request('inventory-correction-candidates', { positionId })
      .then((result) => {
        if (!active) return;
        const values = z.array(correctionCandidate).parse(result);
        setCandidates(values);
        const shops = values.filter((v) => v.provider === 'shopify'),
          erps = values.filter((v) => v.provider === 'jtl');
        setConnectionId((previous) =>
          shops.some((shop) => shop.connectionId === previous)
            ? previous
            : shops.length === 1
              ? shops[0]!.connectionId
              : '',
        );
        setSourceConnectionId((previous) =>
          erps.some((erp) => erp.connectionId === previous)
            ? previous
            : erps.length === 1
              ? erps[0]!.connectionId
              : '',
        );
      })
      .catch((reason) => {
        if (active) setError(services.error(reason));
      });

    return () => {
      active = false;
    };
  }, [positionId, services, refresh]);

  useEffect(() => {
    const current = ++generation.current;
    setData(null);
    setReview(null);
    requestId.current = null;
    if (!connectionId || !sourceConnectionId) {
      setPending(false);

      return;
    }
    setPending(true);
    setError('');
    services
      .request('inventory-correction-inspect', {
        positionId,
        connectionId,
        sourceConnectionId,
      })
      .then((result) => {
        if (current !== generation.current) return;
        const value = inspection.parse(result);
        setData(value);
        setReview(newReview.current ? null : (value.runs[0] ?? null));
        newReview.current = false;
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
  }, [positionId, connectionId, sourceConnectionId, services, refresh]);

  useEffect(() => {
    if (!review || review.acceptance !== 'not_sent') return;
    const id = review.id;
    const timer = window.setTimeout(
      () =>
        setReview((value) =>
          value?.id === id
            ? {
                ...value,
                state: 'denied',
                canApprove: false,
                canExecute: false,
                message: m.shopify_stock_expired(),
              }
            : value,
        ),
      Math.max(0, Date.parse(review.expiresAt) - Date.now()),
    );

    return () => window.clearTimeout(timer);
  }, [review]);

  async function command(
    name: 'preview' | 'approve' | 'execute' | 'check',
    outcome?: 'approved' | 'rejected',
  ) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError('');
    const current = generation.current;
    try {
      requestId.current ??= crypto.randomUUID();
      const value = correctionView.parse(
        await services.request(
          `inventory-correction-${name}`,
          name === 'preview'
            ? {
                positionId,
                connectionId,
                sourceConnectionId,
                requestId: requestId.current,
              }
            : { id: review!.id, ...(outcome ? { outcome } : {}) },
        ),
      );
      if (current === generation.current) setReview(value);
    } catch (reason) {
      if (current === generation.current) {
        if (services.uncertain(reason)) {
          setError(m.shopify_stock_interrupted());
          setReview((value) =>
            value ? { ...value, canExecute: false, canApprove: false } : value,
          );
        } else setError(services.error(reason));
      }
    } finally {
      lock.current = false;
      if (current === generation.current) setPending(false);
    }
  }

  const shops = candidates?.filter((v) => v.provider === 'shopify') ?? [],
    erps = candidates?.filter((v) => v.provider === 'jtl') ?? [];
  const blockerReason = data
    ? correctionBlockerReason(
        data.snapshot,
        { capability: 'inventory.available.reconcile' },
        data.granted,
      )
    : null;
  const blocker = blockerReason ? correctionBlockerText[blockerReason]() : null;
  const snapshot = review?.before ?? data?.snapshot;
  const reload = () => {
    setPending(false);
    setRefresh((value) => value + 1);
  };

  return (
    <Card
      as="section"
      className="shopify-stock-correction"
      aria-label={m.shopify_stock_label()}
      aria-busy={pending}
    >
      <CardHeader>
        <div>
          <CardTitle>{m.shopify_stock_title()}</CardTitle>
          <CardDescription>{m.shopify_stock_description()}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" disabled={pending} onClick={reload}>
          {m.shopify_stock_refresh()}
        </Button>
      </CardHeader>
      <CardContent className="shopify-stock-content">
        <p className="field-help">{m.shopify_stock_rules()}</p>
        {error ? (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        ) : null}
        {!candidates && !error ? (
          <p role="status">{m.shopify_stock_checking_sources()}</p>
        ) : null}
        {candidates && (!shops.length || !erps.length) ? (
          <Alert>{m.shopify_stock_missing_sources()}</Alert>
        ) : null}
        {shops.length && erps.length ? (
          <>
            <div className="shopify-stock-sources">
              <label>
                {m.shopify_stock_store_label()}
                <Select
                  aria-label={m.shopify_stock_store_label()}
                  value={connectionId || null}
                  placeholder={m.shopify_stock_store_placeholder()}
                  disabled={pending}
                  options={shops.map((v) => ({
                    value: v.connectionId,
                    label: v.label,
                  }))}
                  onValueChange={(value) => setConnectionId(value ?? '')}
                />
              </label>
              <label>
                {m.shopify_stock_source_label()}
                <Select
                  aria-label={m.shopify_stock_source_label()}
                  value={
                    review?.target.sourceConnectionId ||
                    sourceConnectionId ||
                    null
                  }
                  placeholder={m.shopify_stock_source_placeholder()}
                  disabled={pending}
                  options={erps.map((v) => ({
                    value: v.connectionId,
                    label:
                      v.available == null
                        ? m.shopify_stock_source_option_unknown({
                            source: v.label,
                          })
                        : m.shopify_stock_source_option({
                            source: v.label,
                            count: v.available,
                          }),
                  }))}
                  onValueChange={(value) => {
                    setReview(null);
                    requestId.current = null;
                    setSourceConnectionId(value ?? '');
                  }}
                />
              </label>
            </div>
            {pending ? <p role="status">{m.shopify_stock_checking()}</p> : null}
            {snapshot ? (
              <>
                <div className="shopify-stock-location">
                  <strong>{snapshot.locationName}</strong>
                  <span className="field-help">
                    {m.shopify_stock_item({
                      item:
                        snapshot.inventoryItemId.split('/').at(-1) ??
                        snapshot.inventoryItemId,
                    })}
                  </span>
                </div>
                <DataTable
                  caption={m.shopify_stock_table_caption()}
                  density="compact"
                  variant="plain"
                  rows={[
                    {
                      id: 'shopify',
                      source:
                        shops.find((s) => s.connectionId === connectionId)
                          ?.label ?? 'Shopify',
                      quantity: snapshot.available,
                      time: snapshot.observedAt,
                    },
                    {
                      id: 'erp',
                      source: snapshot.source.label,
                      quantity: snapshot.source.available,
                      time: snapshot.source.observedAt,
                    },
                  ]}
                  rowKey={(row) => row.id}
                  columns={[
                    {
                      key: 'source',
                      header: m.common_source(),
                      cell: (row) => (
                        <span>
                          {row.id === 'erp'
                            ? m.shopify_stock_role_source({
                                source: row.source,
                              })
                            : m.shopify_stock_role_destination({
                                source: row.source,
                              })}
                        </span>
                      ),
                    },
                    {
                      key: 'available',
                      header: m.shopify_stock_column_available(),
                      numeric: true,
                      cell: (row) => quantity(row.quantity),
                    },
                    {
                      key: 'observed',
                      header: m.shopify_stock_column_read(),
                      cell: (row) => <WorkspaceDate value={row.time} />,
                    },
                  ]}
                />
                <Disclosure>
                  <summary>{m.shopify_stock_details()}</summary>
                  <dl>
                    <dt>{m.shopify_stock_detail_item()}</dt>
                    <dd>{snapshot.inventoryItemId}</dd>
                    <dt>{m.shopify_stock_detail_location()}</dt>
                    <dd>{snapshot.locationId}</dd>
                    <dt>{m.shopify_stock_detail_reading()}</dt>
                    <dd>{snapshot.source.observationId}</dd>
                    {review ? (
                      <>
                        <dt>{m.shopify_stock_detail_correction()}</dt>
                        <dd>{review.id}</dd>
                      </>
                    ) : null}
                  </dl>
                </Disclosure>
                <p className="shopify-stock-change">
                  <strong>
                    {snapshot.available === null
                      ? m.shopify_stock_change_unknown({
                          to: snapshot.source.available,
                        })
                      : m.shopify_stock_change({
                          from: snapshot.available,
                          to: snapshot.source.available,
                        })}
                  </strong>
                  <span className="field-help">
                    {snapshot.available !== null
                      ? m.shopify_stock_delta({
                          count: Math.abs(
                            snapshot.source.available - snapshot.available,
                          ),
                          delta: formatNumber(
                            snapshot.source.available - snapshot.available,
                            { signDisplay: 'exceptZero' },
                          ),
                        })
                      : m.shopify_stock_delta_unknown()}
                  </span>
                </p>
              </>
            ) : null}
            {review ? (
              <div aria-live="polite" className="shopify-stock-review">
                <ol className="shopify-stock-stages">
                  <li>
                    <StatePill
                      state={
                        review.state === 'approval_required'
                          ? 'approval'
                          : review.state === 'denied'
                            ? 'error'
                            : 'idle'
                      }
                    >
                      {review.state === 'denied'
                        ? m.shopify_stock_stage_blocked()
                        : m.shopify_stock_stage_review()}
                    </StatePill>
                  </li>
                  <li>
                    <StatePill
                      state={
                        review.acceptance === 'unknown' ? 'attention' : 'idle'
                      }
                    >
                      {review.acceptance === 'accepted'
                        ? m.shopify_stock_stage_accepted()
                        : review.acceptance === 'unknown'
                          ? m.shopify_stock_stage_unclear()
                          : m.shopify_stock_stage_not_sent()}
                    </StatePill>
                  </li>
                  <li>
                    <StatePill
                      state={
                        review.state === 'verified' ? 'verified' : 'waiting'
                      }
                    >
                      {review.state === 'verified'
                        ? m.shopify_stock_stage_verified()
                        : m.shopify_stock_stage_not_verified()}
                    </StatePill>
                  </li>
                </ol>
                <p>{review.message}</p>
                {review.acceptance === 'not_sent' ? (
                  <p className="field-help">
                    {rich(m.shopify_stock_expires, {
                      time: <WorkspaceDate value={review.expiresAt} />,
                    })}
                  </p>
                ) : null}
                <div className="shopify-stock-controls">
                  {review.canApprove ? (
                    <>
                      <Button
                        disabled={pending}
                        onClick={() => void command('approve', 'approved')}
                      >
                        {m.shopify_stock_approve()}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() => void command('approve', 'rejected')}
                      >
                        {m.shopify_stock_reject()}
                      </Button>
                    </>
                  ) : null}
                  {review.canExecute ? (
                    <Button
                      disabled={pending}
                      onClick={() => void command('execute')}
                    >
                      {m.shopify_stock_send()}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => void command('check')}
                  >
                    {review.acceptance === 'not_sent'
                      ? m.shopify_stock_check_approval()
                      : m.shopify_stock_check()}
                  </Button>
                  {['denied', 'verified', 'recovery_required'].includes(
                    review.state,
                  ) ? (
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        newReview.current = true;
                        reload();
                      }}
                    >
                      {m.shopify_stock_review_new()}
                    </Button>
                  ) : null}
                </div>
                {data && data.runs.length > 1 ? (
                  <label>
                    {m.shopify_stock_saved_label()}
                    <Select
                      aria-label={m.shopify_stock_saved_label()}
                      value={review.id}
                      disabled={pending}
                      options={data.runs.map((v) => ({
                        value: v.id,
                        label: m.shopify_stock_saved_option({
                          from: quantity(v.before.available),
                          to: quantity(v.before.source.available),
                          time: formatDateTime(v.before.observedAt),
                        }),
                      }))}
                      onValueChange={(id) =>
                        setReview(data.runs.find((v) => v.id === id) ?? null)
                      }
                    />
                  </label>
                ) : null}
              </div>
            ) : data ? (
              <>
                {blocker ? <Alert role="status">{blocker}</Alert> : null}
                <div className="shopify-stock-controls">
                  <Button
                    variant="outline"
                    disabled={pending || !!blocker}
                    onClick={() => void command('preview')}
                  >
                    {m.shopify_stock_review()}
                  </Button>
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
