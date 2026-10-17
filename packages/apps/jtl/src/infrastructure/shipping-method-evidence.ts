import { randomUUID } from 'node:crypto';

import type { AppEvidence } from '@luma/app-host';
import {
  type CitedRead,
  type EffectIntent,
  type WriteAcceptance,
  writeReceiptEvidence,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import {
  conflict,
  type SqlTransaction,
  type TenantDatabase,
} from '@luma/platform';
import { z } from 'zod';

const capability = 'orders.shipping-method.write';

const record = z.object({
  resource: z.string().min(1),
  externalId: z.string().min(1),
});
const storedRead = z.object({
  source: z.object({ resource: z.string(), externalId: z.string() }),
  sourceUpdatedAt: z.string().nullable(),
  sourceRevision: z.string().nullable(),
  adapterVersion: z.string(),
  completeness: z.enum(['complete', 'partial']),
  data: z.unknown(),
});
const storedReceipt = z.object({
  capability: z.string(),
  adapterVersion: z.string(),
  dispatchIdentity: z.string(),
  providerRequestId: z.string().nullable(),
  records: z.array(record),
});

/**
 * Stores the reads and receipts a shipping-method correction cites, each in the tenant's own
 * transaction before execution cites its ID. Only a read or acceptance of the intent's own
 * connection is stored; anything else is refused, so the caller cites nothing.
 */
export function createShippingMethodEvidenceStore(database: TenantDatabase) {
  async function insert(
    tenantId: string,
    row: {
      id: string;
      connectionId: string;
      kind: 'read' | 'write_receipt';
      observedAt: string;
      document: unknown;
    },
  ) {
    await database.transaction(tenantId, (tx) =>
      tx.query(
        'INSERT INTO jtl_shipping_method_evidence(tenant_id,id,connection_id,kind,observed_at,document) VALUES($1,$2,$3,$4,$5,$6)',
        [
          tenantId,
          row.id,
          row.connectionId,
          row.kind,
          row.observedAt,
          row.document,
        ],
      ),
    );
  }

  return {
    async storeRead(
      context: TenantContext,
      intent: EffectIntent,
      read: CitedRead,
    ): Promise<void> {
      requireTenant(context, intent.tenantId);
      if (
        read.source.provider !== 'jtl' ||
        read.source.tenantId !== intent.tenantId ||
        read.source.connectionId !== intent.connectionId ||
        read.kind !== 'snapshot'
      )
        throw conflict('The read does not belong to this correction.');
      await insert(context.tenantId, {
        id: read.id,
        connectionId: intent.connectionId,
        kind: 'read',
        observedAt: read.observedAt,
        document: read,
      });
    },
    async storeReceipt(
      context: TenantContext,
      intent: EffectIntent,
      acceptance: WriteAcceptance,
    ): Promise<string> {
      requireTenant(context, intent.tenantId);
      if (
        acceptance.provider !== 'jtl' ||
        acceptance.connectionId !== intent.connectionId ||
        acceptance.capability !== capability
      )
        throw conflict('The receipt does not belong to this correction.');
      const id = randomUUID();
      await insert(context.tenantId, {
        id,
        connectionId: intent.connectionId,
        kind: 'write_receipt',
        observedAt: acceptance.acceptedAt,
        document: writeReceiptEvidence(id, acceptance),
      });

      return id;
    },
  };
}

/**
 * Reads the shipping-method correction evidence with these IDs. The table is not linked to the
 * citing record, so callers pass only IDs the record cites. Rows that no longer parse are left
 * out rather than shown with guessed fields.
 */
export async function readShippingMethodEvidence(
  tx: SqlTransaction,
  tenantId: string,
  ids: string[],
): Promise<AppEvidence[]> {
  if (!ids.length) return [];
  const { rows } = await tx.query<{
    id: string;
    connection_id: string;
    kind: 'read' | 'write_receipt';
    observed_at: Date;
    document: unknown;
  }>(
    `SELECT id::text,connection_id::text,kind,observed_at,document FROM jtl_shipping_method_evidence
     WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
    [tenantId, ids],
  );

  return rows.flatMap((row): AppEvidence[] => {
    const observedAt = row.observed_at.toISOString();
    if (row.kind === 'write_receipt') {
      const receipt = storedReceipt.safeParse(row.document);

      return receipt.success
        ? [
            {
              kind: 'write_receipt',
              id: row.id,
              provider: 'jtl',
              connectionId: row.connection_id,
              capability: receipt.data.capability,
              acceptedAt: observedAt,
              records: receipt.data.records,
              providerRequestId: receipt.data.providerRequestId,
              adapterVersion: receipt.data.adapterVersion,
              dispatchIdentity: receipt.data.dispatchIdentity,
            },
          ]
        : [];
    }
    const read = storedRead.safeParse(row.document);

    return read.success
      ? [
          {
            kind: 'read',
            id: row.id,
            provider: 'jtl',
            connectionId: row.connection_id,
            record: {
              resource: read.data.source.resource,
              externalId: read.data.source.externalId,
            },
            observedAt,
            sourceUpdatedAt: read.data.sourceUpdatedAt,
            sourceRevision: read.data.sourceRevision,
            adapterVersion: read.data.adapterVersion,
            completeness: read.data.completeness,
            data: read.data.data,
          },
        ]
      : [];
  });
}
