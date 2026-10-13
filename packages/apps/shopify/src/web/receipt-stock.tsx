import type { AppUiProps } from '@luma/app-host/web';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import {
  type CorrectionView,
  correctionView,
} from '../domain/inventory-correction.js';

const stateSchema = z.object({
  enabled: z.boolean(),
  runs: z.array(correctionView),
});
const stateLabels = {
  preview: m.procurement_stock_preview,
  approval_required: m.procurement_stock_approval,
  denied: m.procurement_stock_denied,
  accepted: m.procurement_stock_accepted,
  uncertain: m.procurement_stock_uncertain,
  verified: m.procurement_stock_verified,
  recovery_required: m.procurement_stock_unverified,
};

/** Reviews only the undamaged receipt increment and keeps uncertain writes on their existing reconciliation path. */
export function ShopifyReceiptStock({
  receipt,
  services,
  done,
}: {
  done: () => Promise<void>;
  receipt: { purchaseOrderId: string; lineId: string };
  services: AppUiProps['services'];
}) {
  const [runs, setRuns] = useState<CorrectionView[] | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  const requestId = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    services
      .request('inventory-correction-receipt-state', receipt)
      .then((value) => {
        if (!active) return;
        const state = stateSchema.parse(value);
        setEnabled(state.enabled);
        setRuns(state.runs);
      })
      .catch((value) => {
        if (active) setError(services.error(value));
      });

    return () => {
      active = false;
    };
  }, [receipt.purchaseOrderId, receipt.lineId, services, reload]);

  async function command(
    name: 'receipt-preview' | 'approve' | 'execute' | 'check',
    run?: CorrectionView,
    outcome?: 'approved' | 'rejected',
  ) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError('');
    if (name === 'receipt-preview') requestId.current ??= crypto.randomUUID();
    try {
      const body =
        name === 'receipt-preview'
          ? { ...receipt, requestId: requestId.current }
          : { id: run!.id, ...(outcome ? { outcome } : {}) };
      const result = correctionView.parse(
        await services.request(`inventory-correction-${name}`, body),
      );
      setRuns((previous) => [
        result,
        ...(previous ?? []).filter((value) => value.id !== result.id),
      ]);
      if (name === 'receipt-preview') requestId.current = null;
      if (result.state === 'verified') await done();
    } catch (value) {
      setError(services.error(value));
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  if (enabled === false) return null;

  return (
    <Card as="section" className="procurement-section" aria-busy={pending}>
      <h3>{m.procurement_stock_shopify_title()}</h3>
      <p>{m.procurement_stock_note()}</p>
      {runs === null && !error ? (
        <p role="status">{m.common_loading()}</p>
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          <p>{error}</p>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              setError('');
              setReload((value) => value + 1);
            }}
          >
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {enabled && runs ? (
        <Button
          variant="outline"
          disabled={
            pending ||
            runs.some((run) =>
              ['uncertain', 'recovery_required'].includes(run.state),
            )
          }
          onClick={() => void command('receipt-preview')}
        >
          {requestId.current ? m.common_retry() : m.procurement_stock_propose()}
        </Button>
      ) : null}
      {runs?.map((run) => (
        <section key={run.id} className="procurement-section">
          <Badge
            tone={
              run.state === 'verified'
                ? 'success'
                : run.state === 'denied'
                  ? 'danger'
                  : run.state === 'uncertain'
                    ? 'warning'
                    : 'neutral'
            }
          >
            {stateLabels[run.state]()}
          </Badge>
          <p>
            {m.procurement_stock_change({
              before: formatNumber(run.before.available ?? 0),
              after: formatNumber(run.before.source.available),
              quantity: formatNumber(run.target.receipt?.quantity ?? 0),
            })}
          </p>
          <p>
            <WorkspaceDate value={run.before.observedAt} />
          </p>
          {run.canApprove ? (
            <>
              <Button
                disabled={pending}
                onClick={() => void command('approve', run, 'approved')}
              >
                {m.shopify_stock_approve()}
              </Button>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void command('approve', run, 'rejected')}
              >
                {m.shopify_stock_reject()}
              </Button>
            </>
          ) : null}
          {run.canExecute ? (
            <Button
              disabled={pending}
              onClick={() => void command('execute', run)}
            >
              {m.procurement_stock_apply()}
            </Button>
          ) : null}
          {['uncertain', 'recovery_required', 'accepted'].includes(
            run.state,
          ) ? (
            <>
              <Alert tone="warning">
                {m.procurement_stock_uncertain_note()}
              </Alert>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void command('check', run)}
              >
                {m.procurement_stock_check()}
              </Button>
            </>
          ) : null}
          {run.state === 'denied' ? (
            <Alert tone="warning">{m.procurement_stock_changed_note()}</Alert>
          ) : null}
        </section>
      ))}
    </Card>
  );
}
