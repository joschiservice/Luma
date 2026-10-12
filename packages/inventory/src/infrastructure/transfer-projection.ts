import type { SqlTransaction } from '@luma/platform';

import type { CanonicalSnapshot } from '../application/projections.js';
import { transferFacts } from '../domain/receiving.js';

/** Maintains bounded operational lists and exact relationship indexes in the snapshot owner's transaction. */
export async function refreshTransferProjection(
  tx: SqlTransaction,
  tenantId: string,
  items: { snapshotId: string; value: CanonicalSnapshot }[],
) {
  const records = items.flatMap(({ snapshotId, value }) => {
    const data = value.data;
    if (
      data.type !== 'inventory_transfer' &&
      data.type !== 'inventory_shipment'
    )
      return [];

    return [{ snapshotId, value, data }];
  });
  if (!records.length) return;
  for (const table of [
    'inventory_transfer_records',
    'inventory_transfer_references',
    'inventory_transfer_shipments',
  ]) {
    await tx.query(
      `DELETE FROM ${table} r USING unnest($2::uuid[],$3::uuid[]) k(entity_id,connection_id)
      WHERE r.tenant_id=$1 AND r.entity_id=k.entity_id AND r.connection_id=k.connection_id`,
      [
        tenantId,
        records.map((r) => r.value.entityId),
        records.map((r) => r.value.connectionId),
      ],
    );
  }
  await tx.query(
    `INSERT INTO inventory_transfer_records(tenant_id,entity_id,connection_id,kind,snapshot_id,name,status,source_created_at,observed_at,deleted,facts)
    SELECT $1,r.entity_id,r.connection_id,r.kind,r.snapshot_id,r.name,r.status,r.source_created_at,r.observed_at,r.deleted,r.facts
    FROM jsonb_to_recordset($2::jsonb) r(entity_id uuid,connection_id uuid,kind text,snapshot_id uuid,name text,status text,source_created_at timestamptz,observed_at timestamptz,deleted boolean,facts jsonb)`,
    [
      tenantId,
      JSON.stringify(
        records.map(({ snapshotId, value, data }) => ({
          entity_id: value.entityId,
          connection_id: value.connectionId,
          kind: data.type,
          snapshot_id: snapshotId,
          facts: transferFacts(data),
          name: data.name,
          status: data.status,
          source_created_at: data.createdAt,
          observed_at: value.observedAt,
          deleted: value.deleted,
        })),
      ),
    ],
  );
  const references = records.flatMap(({ snapshotId, value, data }) => {
    if (value.deleted) return [];
    const refs = (data.lines ?? []).flatMap((line) =>
      line.skuId ? [{ resource: 'sku', canonical_id: line.skuId }] : [],
    );
    if (data.type === 'inventory_transfer') {
      for (const location of [data.origin, data.destination])
        if (location?.locationId)
          refs.push({
            resource: 'location',
            canonical_id: location.locationId,
          });
    }

    return [
      ...new Map(
        refs.map((ref) => [`${ref.resource}:${ref.canonical_id}`, ref]),
      ).values(),
    ].map((ref) => ({
      ...ref,
      entity_id: value.entityId,
      connection_id: value.connectionId,
      snapshot_id: snapshotId,
    }));
  });
  if (references.length)
    await tx.query(
      `INSERT INTO inventory_transfer_references(tenant_id,entity_id,connection_id,resource,canonical_id,snapshot_id)
    SELECT $1,r.entity_id,r.connection_id,r.resource,r.canonical_id,r.snapshot_id
    FROM jsonb_to_recordset($2::jsonb) r(entity_id uuid,connection_id uuid,resource text,canonical_id uuid,snapshot_id uuid)`,
      [tenantId, JSON.stringify(references)],
    );
  const shipments = records.flatMap(({ snapshotId, value, data }) =>
    data.type === 'inventory_transfer' && !value.deleted
      ? (data.shipmentSources ?? []).map((source) => ({
          entity_id: value.entityId,
          connection_id: value.connectionId,
          shipment_source_id: source.externalId,
          shipment_scope_key: source.scopeKey,
          snapshot_id: snapshotId,
        }))
      : [],
  );
  if (shipments.length)
    await tx.query(
      `INSERT INTO inventory_transfer_shipments(tenant_id,entity_id,connection_id,shipment_source_id,shipment_scope_key,snapshot_id)
    SELECT $1,r.entity_id,r.connection_id,r.shipment_source_id,r.shipment_scope_key,r.snapshot_id
    FROM jsonb_to_recordset($2::jsonb) r(entity_id uuid,connection_id uuid,shipment_source_id text,shipment_scope_key text,snapshot_id uuid)`,
      [tenantId, JSON.stringify(shipments)],
    );
}
