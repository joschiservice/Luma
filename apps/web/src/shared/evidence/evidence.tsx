import type { EvidenceSubject } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import {
  EvidenceList,
  type EvidenceState,
  type EvidenceValueName,
} from '@luma/ui/components/workspace/evidence-list';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import {
  capabilities,
  connectionKindName,
} from '../../kit/connections/presentation';
import { permissionLabel } from '../../kit/identity/permission-text';
import { createWebApiClient } from '../../lib/api-client';
import { ApiError } from '../../lib/api-error';
import { privateQueryDefaults } from '../../lib/private-query';

const client = createWebApiClient();

/**
 * Resolves what a record cites. With `refs`, only those references; without, every reference
 * the record cites, up to the API's limit.
 */
export const evidenceOptions = (
  organizationId: string,
  subject: EvidenceSubject,
  refs?: readonly string[],
) =>
  queryOptions({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'evidence',
      subject.kind,
      subject.id,
      refs ? [...refs] : null,
    ],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      client.evidence.resolve(
        {
          params: { organizationId },
          body: { subject, ...(refs?.length ? { refs: [...refs] } : {}) },
        },
        { signal },
      ),
  });

function isCapability(value: string): value is keyof typeof capabilities {
  return Object.hasOwn(capabilities, value);
}

/** The display name of a provider as reads and receipts record it, such as `jtl`. */
function providerName(provider: string) {
  return provider === 'jtl' ? 'JTL' : connectionKindName(provider);
}

function capabilityName(capability: string) {
  return isCapability(capability) ? capabilities[capability] : capability;
}

function permissionName(permission: string) {
  return permissionLabel(permission, permission);
}

const values: Record<
  Parameters<EvidenceValueName>[0],
  Record<string, () => string>
> = {
  order_status: {
    draft: m.procurement_status_draft,
    open: m.procurement_status_open,
    closed: m.procurement_status_closed,
    cancelled: m.procurement_status_cancelled,
  },
  stock_state: {
    available: m.inventory_native_stock_available,
    reserved: m.inventory_native_stock_reserved,
    held: m.inventory_native_stock_held,
    quarantine: m.inventory_native_stock_quarantine,
    damaged: m.inventory_native_stock_damaged,
    returned_inspection: m.inventory_native_stock_returned_inspection,
    incoming: m.inventory_native_stock_incoming,
    in_transit: m.inventory_native_stock_in_transit,
    supplier: m.inventory_native_stock_supplier,
    customer: m.inventory_native_stock_customer,
    loss: m.inventory_native_stock_loss,
    adjustment: m.inventory_native_stock_adjustment,
    production: m.inventory_native_stock_production,
    external: m.inventory_native_stock_external,
  },
  ledger_purpose: {
    opening: m.evidence_ledger_purpose_opening,
    movement: m.evidence_ledger_purpose_movement,
    correction: m.evidence_ledger_purpose_correction,
    reversal: m.evidence_ledger_purpose_reversal,
    reservation: m.evidence_ledger_purpose_reservation,
    release: m.evidence_ledger_purpose_release,
    dispatch: m.evidence_ledger_purpose_dispatch,
    reconciliation: m.evidence_ledger_purpose_reconciliation,
    production: m.evidence_ledger_purpose_production,
    purchase_receipt: m.evidence_ledger_purpose_purchase_receipt,
  },
};

/** Names an order status, stock state or ledger purpose; unknown values show as recorded. */
const valueName: EvidenceValueName = (kind, value) =>
  Object.hasOwn(values[kind], value)
    ? (values[kind][value]?.() ?? value)
    : value;

/** Shows the state of one evidence read: loading, failed, without access, gone or resolved. */
function Evidence({
  organizationId,
  subject,
  refs,
}: {
  organizationId: string;
  subject: EvidenceSubject;
  refs?: readonly string[];
}) {
  const query = useQuery(evidenceOptions(organizationId, subject, refs));
  const error = query.error;
  const state: EvidenceState = query.data
    ? { status: 'ready', evidence: query.data }
    : !error
      ? { status: 'loading' }
      : error instanceof ApiError && error.status === 403
        ? { status: 'forbidden' }
        : error instanceof ApiError && error.status === 404
          ? { status: 'not_found' }
          : error instanceof ApiError && error.status === 503
            ? { status: 'unavailable' }
            : { status: 'failed', retry: () => void query.refetch() };

  return (
    <EvidenceList
      state={state}
      providerName={providerName}
      capabilityName={capabilityName}
      permissionName={permissionName}
      valueName={valueName}
    />
  );
}

/**
 * A collapsed "Evidence" disclosure that reads what a record cites only once opened, so busy
 * views don't resolve evidence nobody looks at. `count` names how many references it holds when
 * the caller knows.
 */
export function EvidenceDisclosure({
  organizationId,
  subject,
  refs,
  count,
  label,
  className,
}: {
  organizationId: string;
  subject: EvidenceSubject;
  refs?: readonly string[];
  count?: number;
  /** Names the evidence when a view shows more than one disclosure. */
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Disclosure
      className={className}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {label ??
          (count === undefined
            ? m.evidence_disclosure()
            : m.evidence_disclosure_count({ count }))}
      </summary>
      {open ? (
        <Evidence
          organizationId={organizationId}
          subject={subject}
          {...(refs ? { refs } : {})}
        />
      ) : null}
    </Disclosure>
  );
}
