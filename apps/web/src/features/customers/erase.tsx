import './customers.css';

import type { CustomerDetail } from '@luma/api-contract';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { useCan } from '../../kit/identity/permissions';
import { IdentityError } from '../../lib/api-error';
import { eraseCustomer, previewCustomerErasure } from './data';
import { customerName } from './presentation';

/** What the preview lists, in order, with each count's label. */
const previewRows = [
  ['profiles', m.customers_erase_preview_profiles],
  ['messages', m.customers_erase_preview_messages],
  ['threads', m.customers_erase_preview_threads],
  ['replies', m.customers_erase_preview_replies],
  ['rules', m.customers_erase_preview_rules],
] as const;

/**
 * Erases the customer for a data-subject request after confirmation, for members with
 * `customers.erase`. The dialog shows a fresh preview of what will be removed and only then
 * allows erasing. One command ID per dialog, so a retry after a lost response is safe.
 */
export function EraseCustomer({
  organizationId,
  item,
}: {
  organizationId: string;
  item: CustomerDetail['item'];
}) {
  const allowed = useCan(organizationId, 'customers.erase');
  const client = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
  const preview = useQuery({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'customer-erasure-preview',
      item.connectionId,
      item.externalId,
    ],
    enabled: open && allowed,
    // Counts describe the moment the dialog opens, never a cached earlier state.
    staleTime: 0,
    gcTime: 0,
    queryFn: () =>
      previewCustomerErasure(organizationId, {
        connectionId: item.connectionId,
        externalId: item.externalId,
      }),
  });
  const erase = useMutation({
    mutationFn: () =>
      eraseCustomer(organizationId, {
        id: commandId,
        connectionId: item.connectionId,
        externalId: item.externalId,
      }),
    onSuccess: async () => {
      setOpen(false);
      await client.invalidateQueries({
        queryKey: ['private', 'organization', organizationId],
      });
      await navigate({
        to: '/app/$organizationId/customers',
        params: { organizationId },
      });
    },
  });
  if (!allowed) return null;
  const close = () => {
    if (erase.isPending) return;
    setOpen(false);
    erase.reset();
    setCommandId(crypto.randomUUID());
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {m.customers_erase_action()}
      </Button>
      <EraseCustomerDialog
        open={open}
        name={customerName(item)}
        preview={
          preview.isPending
            ? { state: 'loading' }
            : preview.isError
              ? { state: 'failed' }
              : { state: 'ready', counts: preview.data }
        }
        error={
          !erase.error
            ? null
            : erase.error instanceof IdentityError && erase.error.status === 403
              ? 'forbidden'
              : 'failed'
        }
        pending={erase.isPending}
        retryPreview={() => void preview.refetch()}
        confirm={() => erase.mutate()}
        close={close}
      />
    </>
  );
}

type ErasureCounts = Record<(typeof previewRows)[number][0], number>;

/** The preview of an erasure as the dialog shows it. */
export type ErasurePreviewState =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; counts: ErasureCounts };

/**
 * The confirmation dialog of a customer erasure: what it removes, the counts of the current
 * preview, and the outcome of a failed attempt. Erasing is possible only once the preview loaded.
 */
export function EraseCustomerDialog({
  open,
  name,
  preview,
  error,
  pending,
  retryPreview,
  confirm,
  close,
}: {
  open: boolean;
  name: string;
  preview: ErasurePreviewState;
  error: 'forbidden' | 'failed' | null;
  pending: boolean;
  retryPreview: () => void;
  confirm: () => void;
  close: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent>
        <DialogTitle>{m.customers_erase_title({ name })}</DialogTitle>
        <DialogDescription>{m.customers_erase_description()}</DialogDescription>
        <p className="customers-note">{m.customers_erase_scope()}</p>
        {preview.state === 'loading' ? (
          <p role="status">{m.customers_erase_preview_loading()}</p>
        ) : preview.state === 'failed' ? (
          <Alert tone="danger" role="alert">
            {m.customers_erase_preview_failed()}{' '}
            <Button variant="outline" onClick={retryPreview}>
              {m.common_retry()}
            </Button>
          </Alert>
        ) : (
          <section
            className="customers-erase-preview"
            aria-label={m.customers_erase_preview_title()}
          >
            <h3>{m.customers_erase_preview_title()}</h3>
            <dl className="customers-erase-counts">
              {previewRows.map(([key, label]) => (
                <div key={key}>
                  <dt>{label()}</dt>
                  <dd>{formatNumber(preview.counts[key])}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        {error ? (
          <Alert tone="danger" role="alert">
            {error === 'forbidden'
              ? m.customers_erase_forbidden()
              : m.customers_erase_failed()}
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={close}>
            {m.common_cancel()}
          </Button>
          <Button
            variant="destructive"
            disabled={pending || preview.state !== 'ready'}
            onClick={confirm}
          >
            {pending
              ? m.customers_erase_pending()
              : m.customers_erase_confirm()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
