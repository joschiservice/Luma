import { createHash, randomUUID } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import { IdentityError, requireTenant } from '@luma/identity';
import { canonicalJson, type TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { StockEvidence } from '../application/ledger.js';
import type {
  NativeStockDemand,
  NativeStockStore,
  NativeStockTransaction,
} from '../application/native-stock.js';
import { LedgerError, nextStockVersion } from '../domain/ledger.js';
import { createLedgerStore, stockEvidenceSchema } from './ledger-store.js';
import { ledgerReceiptSchema } from './ledger-validation.js';
import {
  ownershipReviewSchema,
  reservationSchema,
  scopeSchema,
  shipmentReadSchema,
} from './native-stock-validation.js';

/** Other owners supply redacted reads on this transaction; Inventory never writes their records. */
export interface NativeStockOwnerReads {
  demand(
    db: TenantDatabase,
    context: TenantContext,
    orderId: string,
    requireAuthority: boolean,
  ): Promise<NativeStockDemand | null>;
  authorityRevision(
    db: TenantDatabase,
    context: TenantContext,
  ): Promise<number>;
  unsettled(
    db: TenantDatabase,
    context: TenantContext,
    connectionId: string,
    locationId: string,
    orderId?: string,
  ): Promise<boolean>;
}
const iso = (value: Date | string) => new Date(value).toISOString();

type ReservationRow = {
  id: string;
  order_id: string;
  order_line_id: string;
  sku_id: string;
  location_id: string;
  unit: string;
  version: string;
  allocated: string;
  remaining: string;
  consumed: string;
  released: string;
  expires_at: Date | null;
  state: string;
  created_at: Date;
  updated_at: Date;
};

const reservation = (row: ReservationRow) =>
  reservationSchema.parse({
    id: row.id,
    orderId: row.order_id,
    orderLineId: row.order_line_id,
    skuId: row.sku_id,
    locationId: row.location_id,
    unit: row.unit,
    version: row.version,
    allocated: row.allocated,
    remaining: row.remaining,
    consumed: row.consumed,
    released: row.released,
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
    state: row.state,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
const reservationColumns =
  'id,order_id,order_line_id,sku_id,location_id,unit,version::text,trim_scale(allocated)::text AS allocated,trim_scale(remaining)::text AS remaining,trim_scale(consumed)::text AS consumed,trim_scale(released)::text AS released,expires_at,state,created_at,updated_at';

type ScopeRow = {
  connection_id: string;
  location_id: string;
  version: string;
  mode: string;
  authority_revision: string;
  last_transition_id: string;
  updated_at: Date;
};

const scope = (row: ScopeRow) =>
  scopeSchema.parse({
    connectionId: row.connection_id,
    locationId: row.location_id,
    version: row.version,
    mode: row.mode,
    authorityRevision: Number(row.authority_revision),
    lastTransitionId: row.last_transition_id,
    updatedAt: iso(row.updated_at),
  });

type ReviewRow = {
  id: string;
  command_key: string;
  intent_hash: string;
  from_mode: string;
  to_mode: string;
  binding: unknown;
  prepared_by: string;
  reviewed_by: string | null;
  state: string;
  reason: string;
  created_at: Date;
  reviewed_at: Date | null;
};

const review = (row: ReviewRow) =>
  ownershipReviewSchema.parse({
    id: row.id,
    key: row.command_key,
    intentHash: row.intent_hash,
    from: row.from_mode,
    to: row.to_mode,
    binding: row.binding,
    preparedBy: row.prepared_by,
    reviewedBy: row.reviewed_by,
    state: row.state,
    reason: row.reason,
    createdAt: iso(row.created_at),
    reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null,
  });
const consumptionSchema = z
  .object({
    key: z.string(),
    commandHash: z.string(),
    consumed: z.string(),
    reservations: z.array(reservationSchema),
    ledger: z.array(ledgerReceiptSchema),
    shipmentReadId: z.string().uuid(),
  })
  .strict();
const resultSchema = z
  .object({
    key: z.string(),
    commandHash: z.string(),
    reservation: reservationSchema.nullable(),
    allocated: z.string(),
    unallocated: z.string(),
    ledger: ledgerReceiptSchema.nullable(),
    orderVersion: z.number().int().nonnegative(),
  })
  .strict();

/** Persists native records, original receipts and audit alongside the ledger on one tenant transaction. */
export function createNativeStockStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
  owners: NativeStockOwnerReads,
): NativeStockStore {
  return {
    transaction: (context, operation) =>
      db.transaction(context.tenantId, async (sql) => {
        const tenant = context.tenantId,
          scoped: TenantDatabase = {
            transaction: async (tenantId, work) => {
              requireTenant(context, tenantId);

              return work(sql);
            },
          };
        await sql.query(
          'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
          [`source-authority:${tenant}`],
        );

        return createLedgerStore(scoped, audit).transaction(
          context,
          async (ledger) => {
            const log = audit(scoped);
            const event: NativeStockTransaction['audit'] = async (
              id,
              key,
              type,
              details,
            ) =>
              log.append({
                id: randomUUID(),
                tenantId: tenant,
                eventKey: `inventory-native:${type}:${key}`,
                eventType: `inventory.native.${type}`,
                schemaVersion: 1,
                occurredAt: new Date().toISOString(),
                actor: { kind: 'user', id: context.actor.id },
                correlationId: context.requestId,
                proposalId: id,
                actionHash: createHash('sha256')
                  .update(canonicalJson([id, key, type, details]))
                  .digest('hex'),
                evidenceRefs: [],
                details,
              });
            const getReview = async (where: string, id: string) => {
              const row = (
                await sql.query<ReviewRow>(
                  `SELECT * FROM inventory_stock_ownership_reviews WHERE tenant_id=$1 AND ${where}=$2`,
                  [tenant, id],
                )
              ).rows[0];

              return row ? review(row) : null;
            };
            const port: NativeStockTransaction = {
              ledger,
              lockOwnership: async () => {
                await sql.query(
                  'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                  [`sales:${tenant}`],
                );
                await sql.query(
                  'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
                  [`commerce-ingestion:${tenant}`],
                );
              },
              lockOrder: async (orderId) => {
                await sql.query(
                  'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                  [`native-stock-order:${tenant}:${orderId}`],
                );
              },
              demand: (orderId, requireAuthority = true) =>
                owners.demand(scoped, context, orderId, requireAuthority),
              authorityRevision: () =>
                owners.authorityRevision(scoped, context),
              unsettled: (connectionId, locationId, orderId) =>
                owners.unsettled(
                  scoped,
                  context,
                  connectionId,
                  locationId,
                  orderId,
                ),
              scope: async (connectionId, locationId, lock) => {
                if (lock)
                  await sql.query(
                    'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                    [`native-stock-location:${tenant}:${locationId}`],
                  );
                const row = (
                  await sql.query<ScopeRow>(
                    `SELECT connection_id,location_id,version::text,mode,authority_revision::text,last_transition_id,updated_at FROM inventory_stock_ownership_scopes WHERE tenant_id=$1 AND location_id=$2 ${lock ? 'FOR UPDATE' : ''}`,
                    [tenant, locationId],
                  )
                ).rows[0];
                if (row) {
                  if (
                    connectionId &&
                    row.mode !== 'observe' &&
                    row.connection_id !== connectionId
                  )
                    throw new LedgerError(
                      'stale',
                      'This location uses a different ownership source.',
                    );

                  return scope(row);
                }
                if (!connectionId)
                  throw new IdentityError(
                    404,
                    'NOT_FOUND',
                    'Stock ownership scope not found',
                  );

                return {
                  connectionId,
                  locationId,
                  version: '0',
                  mode: 'observe',
                  authorityRevision: await owners.authorityRevision(
                    scoped,
                    context,
                  ),
                  lastTransitionId: null,
                  updatedAt: null,
                };
              },
              shipmentRead: async (id) => {
                // Preserve exact mappings and canonical source heads until this stock command commits.
                await sql.query(
                  'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
                  [`commerce-ingestion:${tenant}`],
                );
                const row = (
                  await sql.query<{ document: unknown }>(
                    'SELECT document FROM inventory_native_shipment_reads WHERE tenant_id=$1 AND id=$2',
                    [tenant, id],
                  )
                ).rows[0];
                if (!row) return null;
                const proof = shipmentReadSchema.parse(row.document);
                const heads = (
                  await sql.query<{ snapshot_id: string }>(
                    `SELECT p.snapshot_id FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id WHERE p.tenant_id=$1 AND p.connection_id=$2 AND s.kind='fulfillment' AND s.document->'data'->>'kind'='shipment' AND s.document->'data'->>'orderId'=$3`,
                    [tenant, proof.connectionId, proof.orderId],
                  )
                ).rows;
                if (
                  heads.length !== proof.shipments.length ||
                  heads.some(
                    (head) =>
                      !proof.shipments.some(
                        (shipment) => shipment.snapshotId === head.snapshot_id,
                      ),
                  )
                )
                  throw new LedgerError(
                    'stale',
                    'Shipment observations changed after this complete read.',
                  );
                const latest = (
                  await sql.query<{ id: string }>(
                    'SELECT id FROM inventory_native_shipment_reads WHERE tenant_id=$1 AND order_id=$2 AND connection_id=$3 ORDER BY observed_at DESC,recorded_at DESC,id DESC LIMIT 1',
                    [tenant, proof.orderId, proof.connectionId],
                  )
                ).rows[0];
                if (latest?.id !== proof.id)
                  throw new LedgerError(
                    'stale',
                    'A newer shipment read supersedes this evidence.',
                  );
                const connection = (
                  await sql.query<{ available: boolean }>(
                    "SELECT document->>'status'='active' AND document->'granted' ? 'fulfillment.read' AS available FROM connector_installations WHERE tenant_id=$1 AND id=$2",
                    [tenant, proof.connectionId],
                  )
                ).rows[0];
                if (!connection?.available)
                  throw new LedgerError(
                    'source_incomplete',
                    'The shipment source is unavailable.',
                  );
                const bindings = (
                  await sql.query<{
                    id: string;
                    resource: string;
                    external_id: string;
                    scope_key: string;
                    canonical_id: string;
                  }>(
                    'SELECT id,resource,external_id,scope_key,canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND id=ANY($3::uuid[])',
                    [
                      tenant,
                      proof.connectionId,
                      proof.bindings.map((binding) => binding.mappingId),
                    ],
                  )
                ).rows;
                if (
                  bindings.length !== proof.bindings.length ||
                  proof.bindings.some(
                    (binding) =>
                      !bindings.some(
                        (row) =>
                          row.id === binding.mappingId &&
                          row.resource === binding.resource &&
                          row.external_id === binding.externalId &&
                          row.scope_key === binding.scopeKey &&
                          row.canonical_id === binding.canonicalId,
                      ),
                  )
                )
                  throw new LedgerError(
                    'stale',
                    'Shipment mappings changed after the read.',
                  );

                return proof;
              },
              latestShipmentRead: async (orderId, connectionId) => {
                const row = (
                  await sql.query<{ id: string }>(
                    'SELECT id FROM inventory_native_shipment_reads WHERE tenant_id=$1 AND order_id=$2 AND connection_id=$3 AND complete ORDER BY observed_at DESC,recorded_at DESC,id DESC LIMIT 1',
                    [tenant, orderId, connectionId],
                  )
                ).rows[0];

                return row ? port.shipmentRead(row.id) : null;
              },
              saveShipmentRead: async (value) => {
                const parsed = shipmentReadSchema.parse(value);
                await sql.query(
                  'INSERT INTO inventory_native_shipment_reads(tenant_id,id,connection_id,order_id,observed_at,complete,document) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
                  [
                    tenant,
                    parsed.id,
                    parsed.connectionId,
                    parsed.orderId,
                    parsed.observedAt,
                    parsed.complete,
                    JSON.stringify(parsed),
                  ],
                );
                await event(parsed.id, parsed.id, 'shipment_read', {
                  orderId: parsed.orderId,
                  connectionId: parsed.connectionId,
                  complete: String(parsed.complete),
                });
              },
              dueReservations: async (before, limit, orderId) =>
                (
                  await sql.query<ReservationRow>(
                    `SELECT ${reservationColumns} FROM inventory_native_reservations WHERE tenant_id=$1 AND state='active' AND expires_at<=$2 AND ($4::uuid IS NULL OR order_id=$4) ORDER BY expires_at,id LIMIT $3`,
                    [tenant, before, limit, orderId ?? null],
                  )
                ).rows.map(reservation),
              reservations: async (orderId, lock) =>
                (
                  await sql.query<ReservationRow>(
                    `SELECT ${reservationColumns} FROM inventory_native_reservations WHERE tenant_id=$1 AND order_id=$2 ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,
                    [tenant, orderId],
                  )
                ).rows.map(reservation),
              reservation: async (id, lock) => {
                const row = (
                  await sql.query<ReservationRow>(
                    `SELECT ${reservationColumns} FROM inventory_native_reservations WHERE tenant_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`,
                    [tenant, id],
                  )
                ).rows[0];

                return row ? reservation(row) : null;
              },
              saveReservation: async (value, expected) => {
                const parsed = reservationSchema.parse(value);
                if (expected === null)
                  await sql.query(
                    'INSERT INTO inventory_native_reservations(tenant_id,id,order_id,order_line_id,sku_id,location_id,unit,version,allocated,remaining,consumed,released,expires_at,state,created_at,updated_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
                    [
                      tenant,
                      parsed.id,
                      parsed.orderId,
                      parsed.orderLineId,
                      parsed.skuId,
                      parsed.locationId,
                      parsed.unit,
                      parsed.version,
                      parsed.allocated,
                      parsed.remaining,
                      parsed.consumed,
                      parsed.released,
                      parsed.expiresAt,
                      parsed.state,
                      parsed.createdAt,
                      parsed.updatedAt,
                      context.actor.id,
                    ],
                  );
                else {
                  const updated = await sql.query(
                    'UPDATE inventory_native_reservations SET version=$3,allocated=$4,remaining=$5,consumed=$6,released=$7,state=$8,updated_at=$9 WHERE tenant_id=$1 AND id=$2 AND version=$10',
                    [
                      tenant,
                      parsed.id,
                      parsed.version,
                      parsed.allocated,
                      parsed.remaining,
                      parsed.consumed,
                      parsed.released,
                      parsed.state,
                      parsed.updatedAt,
                      expected,
                    ],
                  );
                  if (updated.rowCount !== 1)
                    throw new LedgerError('stale', 'This reservation changed.');
                }
              },
              reservationReceipt: async (key, hash) => {
                const row = (
                  await sql.query<{
                    command_hash: string;
                    receipt: unknown;
                    operation: string;
                  }>(
                    'SELECT command_hash,receipt,operation FROM inventory_native_stock_commands WHERE tenant_id=$1 AND command_key=$2',
                    [tenant, key],
                  )
                ).rows[0];
                if (row) {
                  if (
                    row.command_hash !== hash ||
                    !['allocation', 'release'].includes(row.operation)
                  )
                    throw new LedgerError(
                      'changed_command',
                      'This key already changed different native stock.',
                    );

                  return resultSchema.parse(row.receipt);
                }
                if (
                  (await ledger.receipt(key)) ||
                  (await ledger.reviewByKey(key)) ||
                  (await ledger.comparison(key)) ||
                  (await getReview('command_key', key))
                )
                  throw new LedgerError(
                    'changed_command',
                    'This key belongs to another stock operation.',
                  );

                return null;
              },
              rememberReservation: async (value) => {
                const parsed = resultSchema.parse(value);
                await sql.query(
                  'INSERT INTO inventory_native_stock_commands(tenant_id,command_key,command_hash,operation,receipt) VALUES($1,$2,$3,$4,$5::jsonb)',
                  [
                    tenant,
                    parsed.key,
                    parsed.commandHash,
                    parsed.allocated === '0' &&
                    parsed.reservation &&
                    parsed.reservation.released !== '0'
                      ? 'release'
                      : 'allocation',
                    JSON.stringify(parsed),
                  ],
                );
              },
              consumptionReceipt: async (key, hash) => {
                const row = (
                  await sql.query<{
                    operation: string;
                    command_hash: string;
                    receipt: unknown;
                  }>(
                    'SELECT operation,command_hash,receipt FROM inventory_native_stock_commands WHERE tenant_id=$1 AND command_key=$2',
                    [tenant, key],
                  )
                ).rows[0];
                if (!row) return null;
                if (
                  row.operation !== 'consumption' ||
                  row.command_hash !== hash
                )
                  throw new LedgerError(
                    'changed_command',
                    'This key belongs to another stock command.',
                  );

                return consumptionSchema.parse(row.receipt);
              },
              rememberConsumption: async (value) => {
                await sql.query(
                  "INSERT INTO inventory_native_stock_commands(tenant_id,command_key,command_hash,operation,receipt) VALUES($1,$2,$3,'consumption',$4::jsonb)",
                  [
                    tenant,
                    value.key,
                    value.commandHash,
                    JSON.stringify(consumptionSchema.parse(value)),
                  ],
                );
              },
              saveConsumption: async (
                id,
                connectionId,
                shipmentId,
                orderLineId,
                reservationId,
                readId,
                entryId,
                quantity,
              ) => {
                await sql.query(
                  'INSERT INTO inventory_native_shipment_consumptions(tenant_id,id,connection_id,shipment_id,order_line_id,reservation_id,read_id,entry_id,quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                  [
                    tenant,
                    id,
                    connectionId,
                    shipmentId,
                    orderLineId,
                    reservationId,
                    readId,
                    entryId,
                    quantity,
                  ],
                );
              },
              shipmentClaim: async (connectionId, shipmentId, orderLineId) => {
                const row = (
                  await sql.query<{ quantity: string }>(
                    'SELECT trim_scale(quantity)::text AS quantity FROM inventory_native_shipment_claims WHERE tenant_id=$1 AND connection_id=$2 AND shipment_id=$3 AND order_line_id=$4',
                    [tenant, connectionId, shipmentId, orderLineId],
                  )
                ).rows[0];

                return row?.quantity ?? '0';
              },
              rememberShipmentClaim: async (
                connectionId,
                shipmentId,
                orderLineId,
                quantity,
                readId,
              ) => {
                const read = await port.shipmentRead(readId),
                  shipment = read?.shipments.find(
                    (value) => value.id === shipmentId,
                  ),
                  line = shipment?.lines.find(
                    (value) => value.orderLineId === orderLineId,
                  );
                if (!read || read.connectionId !== connectionId || !line)
                  throw new LedgerError(
                    'source_incomplete',
                    'The shipment claim lacks its exact read.',
                  );
                await sql.query(
                  `INSERT INTO inventory_native_shipment_claims(tenant_id,connection_id,shipment_id,order_id,order_line_id,unit,quantity,read_id,version,basis) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'consumed') ON CONFLICT(tenant_id,connection_id,shipment_id,order_line_id) DO UPDATE SET quantity=EXCLUDED.quantity,read_id=EXCLUDED.read_id,version=inventory_native_shipment_claims.version+1,recorded_at=clock_timestamp() WHERE inventory_native_shipment_claims.quantity<EXCLUDED.quantity`,
                  [
                    tenant,
                    connectionId,
                    shipmentId,
                    read.orderId,
                    orderLineId,
                    line.unit,
                    quantity,
                    readId,
                  ],
                );
              },
              ownershipEvidence: async (connectionId, locationId) => {
                const current = await port.scope(
                  connectionId,
                  locationId,
                  true,
                );
                const openings = (
                  await sql.query<{
                    sku_id: string;
                    unit: string;
                    review_id: string;
                    source: unknown;
                  }>(
                    `SELECT o.sku_id,o.unit,o.review_id,r.source_bindings->0 AS source FROM inventory_ledger_openings o JOIN inventory_ledger_reviews r ON r.tenant_id=o.tenant_id AND r.id=o.review_id WHERE o.tenant_id=$1 AND o.location_id=$2 ORDER BY o.sku_id,o.unit LIMIT 5001`,
                    [tenant, locationId],
                  )
                ).rows;
                if (openings.length > 5000)
                  throw new LedgerError(
                    'source_incomplete',
                    'Review a smaller ownership scope.',
                  );
                const remaining = (
                  await sql.query<ReservationRow>(
                    `SELECT ${reservationColumns} FROM inventory_native_reservations WHERE tenant_id=$1 AND location_id=$2 AND state='active' ORDER BY id LIMIT 10001 FOR UPDATE`,
                    [tenant, locationId],
                  )
                ).rows;
                if (remaining.length > 10000)
                  throw new LedgerError(
                    'source_incomplete',
                    'This scope has too many active reservations to review at once.',
                  );
                await sql.query(
                  'SELECT id FROM inventory_ledger_accounts WHERE tenant_id=$1 AND location_id=$2 ORDER BY id FOR UPDATE',
                  [tenant, locationId],
                );
                const pools = [];
                for (const opening of openings) {
                  const initial: StockEvidence = stockEvidenceSchema.parse(
                    opening.source,
                  );
                  const snapshots = (
                    await sql.query<{ snapshot_id: string }>(
                      `SELECT p.snapshot_id FROM inventory_projections p JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id WHERE p.tenant_id=$1 AND p.connection_id=$2 AND s.kind='position' AND s.sku_id=$3 AND s.location_id=$4 AND s.unit=$5 ORDER BY p.entity_id LIMIT 2`,
                      [
                        tenant,
                        connectionId,
                        opening.sku_id,
                        locationId,
                        opening.unit,
                      ],
                    )
                  ).rows;
                  const source =
                    snapshots.length === 1
                      ? await ledger.stockEvidence(snapshots[0]!.snapshot_id)
                      : null;
                  const comparison = (
                    await sql.query<{ command_key: string }>(
                      'SELECT command_key FROM inventory_shadow_reconciliations WHERE tenant_id=$1 AND connection_id=$2 AND sku_id=$3 AND location_id=$4 AND unit=$5 ORDER BY recorded_at DESC,id DESC LIMIT 1',
                      [
                        tenant,
                        connectionId,
                        opening.sku_id,
                        locationId,
                        opening.unit,
                      ],
                    )
                  ).rows[0];
                  pools.push({
                    skuId: opening.sku_id,
                    unit: opening.unit,
                    openingReviewId: opening.review_id,
                    opening: initial,
                    source,
                    comparison: comparison
                      ? await ledger.comparison(comparison.command_key)
                      : null,
                    accounts: await ledger.pool(
                      opening.sku_id,
                      locationId,
                      opening.unit,
                      false,
                    ),
                  });
                }

                return {
                  scope: current,
                  authorityRevision: await port.authorityRevision(),
                  unsettled: await port.unsettled(connectionId, locationId),
                  pools,
                  reservations: remaining.map(reservation),
                };
              },
              ownershipReview: (id) => getReview('id', id),
              ownershipReviewByKey: (key) => getReview('command_key', key),
              saveOwnershipReview: async (value) => {
                const parsed = ownershipReviewSchema.parse(value);
                await sql.query(
                  'INSERT INTO inventory_stock_ownership_reviews(tenant_id,id,command_key,intent_hash,from_mode,to_mode,binding,reason,prepared_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',
                  [
                    tenant,
                    parsed.id,
                    parsed.key,
                    parsed.intentHash,
                    parsed.from,
                    parsed.to,
                    JSON.stringify(parsed.binding),
                    parsed.reason,
                    parsed.preparedBy,
                  ],
                );
                await event(parsed.id, parsed.key, 'ownership_prepared', {
                  from: parsed.from,
                  to: parsed.to,
                  locationId: parsed.binding.locationId,
                });
              },
              decideOwnership: async (value, approved, actorId) => {
                const row = (
                  await sql.query<ReviewRow>(
                    "UPDATE inventory_stock_ownership_reviews SET state=$3,reviewed_by=$4,reviewed_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state='pending' RETURNING *",
                    [
                      tenant,
                      value.id,
                      approved ? 'approved' : 'rejected',
                      actorId,
                    ],
                  )
                ).rows[0];
                if (!row)
                  throw new LedgerError(
                    'stale',
                    'This ownership review already has a decision',
                  );
                await event(
                  value.id,
                  value.key,
                  approved ? 'ownership_approved' : 'ownership_rejected',
                  { locationId: value.binding.locationId },
                );

                return review(row);
              },
              transitionReceipt: async (id) => {
                const row = (
                  await sql.query<{
                    connection_id: string;
                    location_id: string;
                    version: string;
                    to_mode: string;
                    binding: { authorityRevision: number };
                    recorded_at: Date;
                  }>(
                    'SELECT connection_id,location_id,version::text,to_mode,binding,recorded_at FROM inventory_stock_ownership_transitions WHERE tenant_id=$1 AND id=$2',
                    [tenant, id],
                  )
                ).rows[0];

                return row
                  ? {
                      connectionId: row.connection_id,
                      locationId: row.location_id,
                      version: row.version,
                      mode: scopeSchema.shape.mode.parse(row.to_mode),
                      authorityRevision: row.binding.authorityRevision,
                      lastTransitionId: id,
                      updatedAt: iso(row.recorded_at),
                    }
                  : null;
              },
              transition: async (value) => {
                const version = nextStockVersion(value.binding.scopeVersion);
                await sql.query(
                  'INSERT INTO inventory_stock_ownership_transitions(tenant_id,id,location_id,connection_id,version,review_id,command_key,from_mode,to_mode,binding,actor_id,reviewer_id) VALUES($1,$2,$3,$4,$5,$2,$6,$7,$8,$9::jsonb,$10,$11)',
                  [
                    tenant,
                    value.id,
                    value.binding.locationId,
                    value.binding.connectionId,
                    version,
                    value.key,
                    value.from,
                    value.to,
                    JSON.stringify(value.binding),
                    context.actor.id,
                    value.reviewedBy,
                  ],
                );
                if (value.binding.scopeVersion === '0')
                  await sql.query(
                    'INSERT INTO inventory_stock_ownership_scopes(tenant_id,location_id,connection_id,version,mode,authority_revision,last_transition_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
                    [
                      tenant,
                      value.binding.locationId,
                      value.binding.connectionId,
                      version,
                      value.to,
                      value.binding.authorityRevision,
                      value.id,
                    ],
                  );
                else {
                  const changed = await sql.query(
                    'UPDATE inventory_stock_ownership_scopes SET connection_id=$3,version=$4,mode=$5,authority_revision=$6,last_transition_id=$7 WHERE tenant_id=$1 AND location_id=$2 AND version=$8',
                    [
                      tenant,
                      value.binding.locationId,
                      value.binding.connectionId,
                      version,
                      value.to,
                      value.binding.authorityRevision,
                      value.id,
                      value.binding.scopeVersion,
                    ],
                  );
                  if (changed.rowCount !== 1)
                    throw new LedgerError(
                      'stale',
                      'Location ownership changed.',
                    );
                }
                await event(value.id, value.key, 'ownership_changed', {
                  from: value.from,
                  to: value.to,
                  locationId: value.binding.locationId,
                });

                return (await port.transitionReceipt(value.id))!;
              },
              audit: event,
            };

            return operation(port);
          },
        );
      }),
  };
}
