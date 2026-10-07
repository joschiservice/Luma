import './inventory-correction.css';

import type { AppUiProps } from '@luma/app-host/web';
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
  correctionBlocker,
  type CorrectionCandidate,
  correctionCandidate,
  correctionSnapshot,
  type CorrectionView,
  correctionView,
} from '../domain/inventory-correction.js';

const inspection = z.object({
  snapshot: correctionSnapshot,
  granted: z.array(z.string()),
  runs: z.array(correctionView),
});

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
                message:
                  'This review expired. Sync the ERP and refresh before reviewing again.',
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
          setError(
            'The response was interrupted. Refresh to recover the saved correction before continuing.',
          );
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
  const blocker = data
    ? correctionBlocker(
        data.snapshot,
        { capability: 'inventory.available.reconcile' },
        data.granted,
      )
    : null;
  const snapshot = review?.before ?? data?.snapshot;
  const reload = () => {
    setPending(false);
    setRefresh((value) => value + 1);
  };

  return (
    <Card
      as="section"
      className="shopify-stock-correction"
      aria-label="Shopify stock correction"
      aria-busy={pending}
    >
      <CardHeader>
        <div>
          <CardTitle>Reconcile Shopify stock</CardTitle>
          <CardDescription>
            Use a confirmed ERP quantity. Review, approve, then verify.
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" disabled={pending} onClick={reload}>
          Refresh correction
        </Button>
      </CardHeader>
      <CardContent className="shopify-stock-content">
        <p className="field-help">
          ERP → Shopify · Available stock only · ERP stock stays authoritative.
          Someone else who can approve changes must approve each correction.
        </p>
        {error ? (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        ) : null}
        {!candidates && !error ? (
          <p role="status">Checking stock sources…</p>
        ) : null}
        {candidates && (!shops.length || !erps.length) ? (
          <Alert>
            This position needs an active Shopify connection and a matching ERP
            source. Confirm SKU and location mappings, then sync both sources.
          </Alert>
        ) : null}
        {shops.length && erps.length ? (
          <>
            <div className="shopify-stock-sources">
              <label>
                Shopify destination
                <Select
                  aria-label="Shopify destination"
                  value={connectionId || null}
                  placeholder="Choose a store"
                  disabled={pending}
                  options={shops.map((v) => ({
                    value: v.connectionId,
                    label: v.label,
                  }))}
                  onValueChange={(value) => setConnectionId(value ?? '')}
                />
              </label>
              <label>
                Authoritative ERP source
                <Select
                  aria-label="Authoritative ERP source"
                  value={
                    review?.target.sourceConnectionId ||
                    sourceConnectionId ||
                    null
                  }
                  placeholder="Choose the source to trust"
                  disabled={pending}
                  options={erps.map((v) => ({
                    value: v.connectionId,
                    label: `${v.label} · ${v.available ?? 'Unknown'} available`,
                  }))}
                  onValueChange={(value) => {
                    setReview(null);
                    requestId.current = null;
                    setSourceConnectionId(value ?? '');
                  }}
                />
              </label>
            </div>
            {pending ? <p role="status">Checking correction…</p> : null}
            {snapshot ? (
              <>
                <div className="shopify-stock-location">
                  <strong>{snapshot.locationName}</strong>
                  <span className="field-help">
                    {snapshot.inventoryItemId.split('/').at(-1)} · Available
                    units
                  </span>
                </div>
                <DataTable
                  caption="Reviewed stock correction"
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
                      header: 'Source',
                      cell: (row) => (
                        <span>
                          {row.source}
                          {row.id === 'erp' ? ' · Authority' : ' · Destination'}
                        </span>
                      ),
                    },
                    {
                      key: 'available',
                      header: 'Available',
                      numeric: true,
                      cell: (row) => row.quantity ?? 'Unknown',
                    },
                    {
                      key: 'observed',
                      header: 'Evidence read',
                      cell: (row) => <WorkspaceDate value={row.time} />,
                    },
                  ]}
                />
                <Disclosure>
                  <summary>Evidence & exact target</summary>
                  <dl>
                    <dt>Shopify inventory item</dt>
                    <dd>{snapshot.inventoryItemId}</dd>
                    <dt>Shopify location</dt>
                    <dd>{snapshot.locationId}</dd>
                    <dt>ERP observation</dt>
                    <dd>{snapshot.source.observationId}</dd>
                    {review ? (
                      <>
                        <dt>Correction</dt>
                        <dd>{review.id}</dd>
                      </>
                    ) : null}
                  </dl>
                </Disclosure>
                <p className="shopify-stock-change">
                  <strong>
                    {snapshot.available ?? 'Unknown'} →{' '}
                    {snapshot.source.available} available
                  </strong>
                  <span className="field-help">
                    {snapshot.available !== null
                      ? `${snapshot.source.available - snapshot.available > 0 ? '+' : ''}${snapshot.source.available - snapshot.available} units in Shopify`
                      : 'Quantity unavailable'}
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
                        ? 'Correction blocked'
                        : 'Review & approval'}
                    </StatePill>
                  </li>
                  <li>
                    <StatePill
                      state={
                        review.acceptance === 'unknown' ? 'attention' : 'idle'
                      }
                    >
                      {review.acceptance === 'accepted'
                        ? 'Shopify accepted'
                        : review.acceptance === 'unknown'
                          ? 'Write uncertain'
                          : 'Not sent'}
                    </StatePill>
                  </li>
                  <li>
                    <StatePill
                      state={
                        review.state === 'verified' ? 'verified' : 'waiting'
                      }
                    >
                      {review.state === 'verified'
                        ? 'Quantity verified'
                        : 'Not verified'}
                    </StatePill>
                  </li>
                </ol>
                <p>{review.message}</p>
                {review.acceptance === 'not_sent' ? (
                  <p className="field-help">
                    Review expires <WorkspaceDate value={review.expiresAt} />.
                    Changes to either source require a new review.
                  </p>
                ) : null}
                <div className="shopify-stock-controls">
                  {review.canApprove ? (
                    <>
                      <Button
                        disabled={pending}
                        onClick={() => void command('approve', 'approved')}
                      >
                        Approve correction
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
                    <Button
                      disabled={pending}
                      onClick={() => void command('execute')}
                    >
                      Apply to Shopify
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => void command('check')}
                  >
                    {review.acceptance === 'not_sent'
                      ? 'Check approval'
                      : 'Verify stock'}
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
                      Review a new correction
                    </Button>
                  ) : null}
                </div>
                {data && data.runs.length > 1 ? (
                  <label>
                    Saved corrections
                    <Select
                      aria-label="Saved corrections"
                      value={review.id}
                      disabled={pending}
                      options={data.runs.map((v) => ({
                        value: v.id,
                        label: `${v.before.available} → ${v.before.source.available} · ${new Date(v.before.observedAt).toLocaleString()}`,
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
                    Review correction
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
