import { createHash, randomUUID } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import {
  canonicalJson,
  type SqlTransaction,
  type TenantDatabase,
} from '@luma/platform';
import { z } from 'zod';

import type {
  LedgerReceipt,
  LedgerReview,
  LedgerStore,
  LedgerTransaction,
  PurchaseReceiptEvidence,
  ShadowComparison,
  StockEvidence,
} from '../application/ledger.js';
import {
  type AccountAddress,
  accountKey,
  decimalQuantity,
  type LedgerAccount,
  LedgerError,
  planPostings,
  type PostingCommand,
  quantityUnits,
} from '../domain/ledger.js';
import {
  addressSchema,
  ledgerReceiptSchema,
  postingCommandSchema,
} from './ledger-validation.js';
import { snapshotSchema } from './validation.js';

const idFor = (tenant: string, address: AccountAddress) => {
  const value = createHash('sha256')
    .update(canonicalJson(['inventory-account', tenant, address]))
    .digest('hex');

  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-${((parseInt(value.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${value.slice(18, 20)}-${value.slice(20, 32)}`;
};
const iso = (value: Date | string) => new Date(value).toISOString();

type AccountRow = {
  id: string;
  sku_id: string;
  location_id: string;
  unit: string;
  state: string;
  connection_id: string | null;
  balance: string;
  version: string;
};

const account = (row: AccountRow): LedgerAccount => ({
  id: row.id,
  address: addressSchema.parse({
    skuId: row.sku_id,
    locationId: row.location_id,
    unit: row.unit,
    state: row.state,
    ...(row.connection_id ? { connectionId: row.connection_id } : {}),
  }),
  balance: row.balance,
  version: row.version,
});
const columns =
  'id,sku_id,location_id,unit,state,connection_id,trim_scale(balance)::text AS balance,version::text AS version';

export const stockEvidenceSchema = z.object({
  snapshotId: z.string().uuid(),
  observationId: z.string().uuid(),
  connectionId: z.string().uuid(),
  skuId: z.string().uuid(),
  locationId: z.string().uuid(),
  unit: z.string(),
  onHand: z.string().nullable(),
  available: z.string().nullable(),
  incoming: z.string().nullable(),
  observedAt: z.string(),
  sourceUpdatedAt: z.string().nullable(),
  mappingVersion: z.string(),
  sourceRevision: z.string().nullable(),
  meaningHash: z.string().regex(/^[a-f0-9]{64}$/),
  channelReplica: z.boolean().optional(),
  channelState: z
    .object({
      semantics: z.literal('shopify/1'),
      damaged: z.string().nullable().optional(),
      qualityControl: z.string().nullable().optional(),
      safetyStock: z.string().nullable().optional(),
      committed: z.string().nullable(),
      reserved: z.string().nullable(),
      itemActive: z.boolean().nullable(),
      locationActive: z.boolean().nullable(),
      tracked: z.boolean().nullable(),
    })
    .nullable()
    .optional(),
  complete: z.boolean(),
  bundleParent: z.boolean().nullable(),
});

type ReviewRow = {
  id: string;
  command_key: string;
  command_hash: string;
  intent_hash: string;
  command_document: unknown;
  source_bindings: unknown;
  prepared_by: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  state: 'pending' | 'approved' | 'rejected';
  created_at: Date;
};

const review = (row: ReviewRow): LedgerReview => ({
  id: row.id,
  commandKey: row.command_key,
  commandHash: row.command_hash,
  intentHash: row.intent_hash,
  command: postingCommandSchema.parse(row.command_document),
  sources: z.array(stockEvidenceSchema).parse(row.source_bindings),
  preparedBy: row.prepared_by,
  reviewedBy: row.reviewed_by,
  reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null,
  state: row.state,
  createdAt: iso(row.created_at),
});

/** Owns stock journal persistence, exact version locks and atomic audit; every query carries tenant scope. */
export function createLedgerStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
  options: {
    purchaseReceipt?: (
      scoped: TenantDatabase,
      context: import('@luma/identity').TenantContext,
      purchaseOrderId: string,
      lineId: string,
    ) => Promise<Omit<
      PurchaseReceiptEvidence,
      'bookedGood' | 'bookedDamaged' | 'trackedIncoming'
    > | null>;
  } = {},
): LedgerStore {
  return {
    transaction: (context, operation) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
          [`commerce-ingestion:${context.tenantId}`],
        );
        const tenant = context.tenantId,
          log = audit({ transaction: async (_tenant, fn) => fn(tx) });
        const appendAudit = async (
          id: string,
          key: string,
          hash: string,
          event: string,
          evidence: string[],
          details: Record<string, string>,
        ) =>
          log.append({
            id: randomUUID(),
            tenantId: tenant,
            eventKey: `inventory-ledger:${event}:${key}`,
            eventType: `inventory.ledger.${event}`,
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            actor: { kind: 'user', id: context.actor.id },
            correlationId: context.requestId,
            proposalId: id,
            actionHash: hash,
            evidenceRefs: evidence,
            details,
          });
        const accounts: LedgerTransaction['accounts'] = async (
          addresses,
          lock,
        ) => {
          const list = [
            ...new Map(
              addresses.map((address) => [accountKey(address), address]),
            ).values(),
          ]
            .map((address) => ({ id: idFor(tenant, address), address }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          if (!list.length) return [];
          // Creating in the same order as row locking prevents overlapping first commands from deadlocking.
          for (const item of list)
            await tx.query(
              `INSERT INTO inventory_ledger_accounts(tenant_id,id,sku_id,location_id,unit,state,connection_id) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(tenant_id,sku_id,location_id,unit,state,connection_id) DO NOTHING`,
              [
                tenant,
                item.id,
                item.address.skuId,
                item.address.locationId,
                item.address.unit,
                item.address.state,
                item.address.state === 'external'
                  ? item.address.connectionId
                  : null,
              ],
            );
          const rows = await tx.query<AccountRow>(
            `SELECT ${columns} FROM inventory_ledger_accounts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,
            [tenant, list.map((item) => item.id)],
          );
          if (rows.rows.length !== list.length)
            throw new LedgerError(
              'invalid_entry',
              'Account identity is unavailable.',
            );

          return rows.rows.map(account);
        };
        const remember = async (
          command: PostingCommand,
          hash: string,
          result: LedgerReceipt,
        ) => {
          await tx.query(
            'INSERT INTO inventory_ledger_commands(tenant_id,command_key,command_hash,receipt) VALUES($1,$2,$3,$4::jsonb)',
            [tenant, command.key, hash, JSON.stringify(result)],
          );
          await appendAudit(
            command.id,
            command.key,
            hash,
            'posted',
            command.evidence.map((evidence) => evidence.id),
            {
              purpose: command.purpose,
              entryId: result.entryId ?? '',
              accounts: String(result.accounts.length),
            },
          );

          return result;
        };
        const getReview = async (sql: string, values: unknown[]) => {
          const row = (await tx.query<ReviewRow>(sql, values)).rows[0];

          return row ? review(row) : null;
        };
        const port: LedgerTransaction = {
          lockCommand: async (key) => {
            await tx.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [`inventory-ledger:${tenant}:${key}`],
            );
          },
          receipt: async (key, hash) => {
            const row = (
              await tx.query<{ command_hash: string; receipt: unknown }>(
                'SELECT command_hash,receipt FROM inventory_ledger_commands WHERE tenant_id=$1 AND command_key=$2',
                [tenant, key],
              )
            ).rows[0];
            if (!row) {
              const used = await tx.query(
                `SELECT 1 FROM inventory_native_stock_commands WHERE tenant_id=$1 AND command_key=$2 UNION ALL SELECT 1 FROM inventory_stock_ownership_reviews WHERE tenant_id=$1 AND command_key=$2 LIMIT 1`,
                [tenant, key],
              );
              if (used.rowCount)
                throw new LedgerError(
                  'changed_command',
                  'This key belongs to another stock operation.',
                );

              return null;
            }
            if (hash && row.command_hash !== hash)
              throw new LedgerError(
                'changed_command',
                'This key already committed different stock.',
              );

            return ledgerReceiptSchema.parse(row.receipt);
          },
          accounts,
          pool: async (skuId, locationId, unit, lock) =>
            (
              await tx.query<AccountRow>(
                `SELECT ${columns} FROM inventory_ledger_accounts WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND unit=$4 ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,
                [tenant, skuId, locationId, unit],
              )
            ).rows.map(account),
          stockEvidence: async (snapshotId) =>
            stockEvidence(tx, tenant, snapshotId),
          historical: async (
            address,
            effectiveAt,
            recordedAt,
            maximumVersion,
          ) => {
            const current = (
              await tx.query<AccountRow>(
                `SELECT ${columns} FROM inventory_ledger_accounts WHERE tenant_id=$1 AND id=$2`,
                [tenant, idFor(tenant, address)],
              )
            ).rows[0];
            if (!current) return null;
            const totals = (
              await tx.query<{
                known: string;
                unknown: string;
                unknown_count: string;
                recorded_version: string;
              }>(
                `WITH prefix AS (
     SELECT * FROM inventory_ledger_checkpoints WHERE tenant_id=$1 AND account_id=$2 AND version<=$5 AND recorded_at<=$4 AND (maximum_effective_at IS NULL OR maximum_effective_at<=$3) ORDER BY version DESC LIMIT 1
    ), tail AS (SELECT COALESCE(sum(quantity) FILTER(WHERE effective_at<=$3),0) AS known,COALESCE(sum(quantity) FILTER(WHERE effective_at IS NULL),0) AS unknown,count(*) FILTER(WHERE effective_at IS NULL) AS unknown_count
     FROM inventory_ledger_postings WHERE tenant_id=$1 AND account_id=$2 AND account_version>COALESCE((SELECT version FROM prefix),0) AND account_version<=$5 AND recorded_at<=$4)
    SELECT trim_scale(COALESCE((SELECT known_quantity FROM prefix),0)+tail.known)::text AS known,trim_scale(COALESCE((SELECT unknown_quantity FROM prefix),0)+tail.unknown)::text AS unknown,(COALESCE((SELECT unknown_count FROM prefix),0)+tail.unknown_count)::text AS unknown_count,
    (SELECT COALESCE(max(account_version),0)::text FROM inventory_ledger_postings WHERE tenant_id=$1 AND account_id=$2 AND account_version<=$5 AND recorded_at<=$4) AS recorded_version FROM tail`,
                [tenant, current.id, effectiveAt, recordedAt, maximumVersion],
              )
            ).rows[0]!;

            return {
              account: { id: current.id, address: account(current).address },
              effectiveAt,
              recordedAt,
              maximumVersion,
              knownQuantity: totals.known,
              unknownQuantity: totals.unknown,
              unknownCount: totals.unknown_count,
              recordedVersion: totals.recorded_version,
            };
          },
          aging: async (before, limit) => {
            const rows = (
              await tx.query<
                AccountRow & {
                  aging_entry_id: string;
                  since: Date;
                  basis: 'effective' | 'recorded';
                }
              >(
                `SELECT ${columns},aging_entry_id,COALESCE(nonzero_since_effective,nonzero_since_recorded) AS since,CASE WHEN nonzero_since_effective IS NULL THEN 'recorded' ELSE 'effective' END AS basis FROM inventory_ledger_accounts
     WHERE tenant_id=$1 AND state IN ('in_transit','returned_inspection','external') AND balance<>0 AND COALESCE(nonzero_since_effective,nonzero_since_recorded)<=$2 ORDER BY COALESCE(nonzero_since_effective,nonzero_since_recorded),id LIMIT $3`,
                [tenant, before, limit],
              )
            ).rows;

            return rows.map((row) => ({
              account: account(row),
              entryId: row.aging_entry_id,
              since: iso(row.since),
              basis: row.basis,
              kind:
                row.state === 'external'
                  ? 'drift'
                  : row.state === 'in_transit'
                    ? 'transit'
                    : 'inspection',
            }));
          },
          comparison: async (key) => {
            const row = (
              await tx.query<{
                id: string;
                command_key: string;
                source_document: unknown;
                native_quantity: string;
                drift_quantity: string;
                native_versions: ShadowComparison['nativeVersions'];
                entry_id: string | null;
              }>(
                `SELECT id,command_key,source_document,trim_scale(native_quantity)::text AS native_quantity,trim_scale(drift_quantity)::text AS drift_quantity,native_versions,entry_id FROM inventory_shadow_reconciliations WHERE tenant_id=$1 AND command_key=$2`,
                [tenant, key],
              )
            ).rows[0];
            if (!row) return null;

            return {
              id: row.id,
              key: row.command_key,
              source: stockEvidenceSchema.parse(row.source_document),
              nativeQuantity: row.native_quantity,
              driftQuantity: row.drift_quantity,
              nativeVersions: row.native_versions,
              entryId: row.entry_id,
            };
          },
          saveComparison: async (value) => {
            const physical = (
              await accounts(
                [
                  {
                    skuId: value.source.skuId,
                    locationId: value.source.locationId,
                    unit: value.source.unit,
                    state: 'available',
                  },
                ],
                false,
              )
            )[0]!;
            const drift = (
              await accounts(
                [
                  {
                    skuId: value.source.skuId,
                    locationId: value.source.locationId,
                    unit: value.source.unit,
                    state: 'external',
                    connectionId: value.source.connectionId,
                  },
                ],
                false,
              )
            )[0]!;
            await tx.query(
              'INSERT INTO inventory_shadow_reconciliations(tenant_id,id,command_key,connection_id,sku_id,location_id,unit,native_account_id,native_version,native_versions,native_quantity,provider_quantity,source_document,observation_id,snapshot_id,observed_at,drift_account_id,drift_quantity,entry_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19)',
              [
                tenant,
                value.id,
                value.key,
                value.source.connectionId,
                value.source.skuId,
                value.source.locationId,
                value.source.unit,
                physical.id,
                physical.version,
                JSON.stringify(value.nativeVersions),
                value.nativeQuantity,
                value.source.onHand,
                JSON.stringify(value.source),
                value.source.observationId,
                value.source.snapshotId,
                value.source.observedAt,
                drift.id,
                value.driftQuantity,
                value.entryId,
              ],
            );
          },
          nativeReceiptLines: async (purchaseOrderId) => {
            const result = await tx.query<{ id: string }>(
              `SELECT line->>'id' AS id FROM procurement_purchase_orders o CROSS JOIN LATERAL jsonb_array_elements(o.document->'lines') line JOIN inventory_stock_ownership_scopes scope ON scope.tenant_id=o.tenant_id AND scope.location_id=(line->>'locationId')::uuid AND scope.mode='own' WHERE o.tenant_id=$1 AND o.id=$2`,
              [tenant, purchaseOrderId],
            );

            return result.rows.map((r) => r.id);
          },
          purchaseReceiptReviews: async (purchaseOrderId) => {
            const rows = await tx.query<ReviewRow>(
              `SELECT * FROM inventory_ledger_reviews WHERE tenant_id=$1 AND command_document ? 'purchaseReceipt' AND ($2::text IS NULL OR command_document->'purchaseReceipt'->>'purchaseOrderId'=$2) ORDER BY created_at DESC LIMIT 100`,
              [tenant, purchaseOrderId],
            );

            return rows.rows.map(review);
          },
          purchaseReceipt: async (purchaseOrderId, lineId) => {
            await tx.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [`native-purchase-order:${tenant}:${purchaseOrderId}`],
            );
            await tx.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [`native-receipt:${tenant}:${purchaseOrderId}:${lineId}`],
            );
            await tx.query(
              'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
              [`procurement:${tenant}`],
            );
            const source = await options.purchaseReceipt?.(
              { transaction: async (_tenant, operation) => operation(tx) },
              context,
              purchaseOrderId,
              lineId,
            );
            if (!source) return null;
            const booked = (
              await tx.query<{ good: string; damaged: string }>(
                'SELECT trim_scale(good)::text AS good,trim_scale(damaged)::text AS damaged FROM inventory_purchase_receipt_bookings WHERE tenant_id=$1 AND purchase_order_id=$2 AND line_id=$3',
                [tenant, purchaseOrderId, lineId],
              )
            ).rows[0];

            const tracked = (
              await tx.query<{ outstanding: string }>(
                'SELECT trim_scale(outstanding_quantity)::text AS outstanding FROM inventory_purchase_incoming WHERE tenant_id=$1 AND purchase_order_id=$2 AND line_id=$3',
                [tenant, purchaseOrderId, lineId],
              )
            ).rows[0];

            return {
              ...source,
              bookedGood: booked?.good ?? '0',
              bookedDamaged: booked?.damaged ?? '0',
              trackedIncoming: tracked?.outstanding ?? '0',
            };
          },
          review: (id) =>
            getReview(
              'SELECT * FROM inventory_ledger_reviews WHERE tenant_id=$1 AND id=$2',
              [tenant, id],
            ),
          reviewByKey: (key) =>
            getReview(
              'SELECT * FROM inventory_ledger_reviews WHERE tenant_id=$1 AND command_key=$2',
              [tenant, key],
            ),
          entry: async (id) => {
            const row = (
              await tx.query<{
                receipt: unknown;
                command_document: unknown;
                reversed: boolean;
              }>(
                `SELECT r.command_document,EXISTS(SELECT 1 FROM inventory_ledger_entries reversal WHERE reversal.tenant_id=e.tenant_id AND reversal.reversal_of=e.id) AS reversed
     FROM inventory_ledger_entries e JOIN inventory_ledger_reviews r ON r.tenant_id=e.tenant_id AND r.id=e.review_id WHERE e.tenant_id=$1 AND e.id=$2`,
                [tenant, id],
              )
            ).rows[0];
            if (row)
              return {
                command: postingCommandSchema.parse(row.command_document),
                reversed: row.reversed,
              };
            const entry = (
              await tx.query<{
                id: string;
                command_key: string;
                purpose: PostingCommand['purpose'];
                reason: string;
                effective_at: Date | null;
                evidence_refs: PostingCommand['evidence'];
                reversed: boolean;
              }>(
                `SELECT e.*,EXISTS(SELECT 1 FROM inventory_ledger_entries reversal WHERE reversal.tenant_id=e.tenant_id AND reversal.reversal_of=e.id) AS reversed FROM inventory_ledger_entries e WHERE e.tenant_id=$1 AND e.id=$2`,
                [tenant, id],
              )
            ).rows[0];
            if (!entry) return null;
            const postings = (
              await tx.query<AccountRow & { quantity: string }>(
                `SELECT a.id,a.sku_id,a.location_id,a.unit,a.state,a.connection_id,p.balance_before::text AS balance,(p.account_version-1)::text AS version,trim_scale(p.quantity)::text AS quantity FROM inventory_ledger_postings p JOIN inventory_ledger_accounts a ON a.tenant_id=p.tenant_id AND a.id=p.account_id WHERE p.tenant_id=$1 AND p.entry_id=$2 ORDER BY a.id`,
                [tenant, id],
              )
            ).rows;

            return {
              reversed: entry.reversed,
              command: {
                id: entry.id,
                key: entry.command_key,
                purpose: entry.purpose,
                reason: entry.reason,
                effectiveAt: entry.effective_at
                  ? iso(entry.effective_at)
                  : null,
                evidence: entry.evidence_refs,
                postings: postings.map((row) => ({
                  account: account(row).address,
                  quantity: row.quantity,
                })),
                expected: postings.map((row) => ({
                  account: account(row).address,
                  balance: row.balance,
                  version: row.version,
                })),
              },
            };
          },
          saveReview: async (value) => {
            await tx.query(
              'INSERT INTO inventory_ledger_reviews(tenant_id,id,command_key,intent_hash,command_hash,command_document,source_bindings,prepared_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',
              [
                tenant,
                value.id,
                value.commandKey,
                value.intentHash,
                value.commandHash,
                JSON.stringify(value.command),
                JSON.stringify(value.sources),
                value.preparedBy,
              ],
            );
            await appendAudit(
              value.id,
              value.commandKey,
              value.commandHash,
              'prepared',
              value.sources.map((source) => source.observationId),
              { purpose: value.command.purpose },
            );
          },
          decide: async (value, approved, actorId) => {
            const row = (
              await tx.query<ReviewRow>(
                "UPDATE inventory_ledger_reviews SET state=$3,reviewed_by=$4,reviewed_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state='pending' RETURNING *",
                [tenant, value.id, approved ? 'approved' : 'rejected', actorId],
              )
            ).rows[0];
            if (!row)
              throw new LedgerError(
                'stale',
                'This review already has a decision.',
              );
            await appendAudit(
              value.id,
              value.commandKey,
              value.commandHash,
              approved ? 'approved' : 'rejected',
              value.sources.map((source) => source.observationId),
              {},
            );

            return review(row);
          },
          commit: async (command, hash, locked, reviewId) => {
            const changes = planPostings(command, locked);
            const recorded = (
              await tx.query<{ recorded_at: Date }>(
                'INSERT INTO inventory_ledger_entries(tenant_id,id,command_key,command_hash,purpose,reason,actor_id,evidence_refs,effective_at,reversal_of,review_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING recorded_at',
                [
                  tenant,
                  command.id,
                  command.key,
                  hash,
                  command.purpose,
                  command.reason,
                  context.actor.id,
                  JSON.stringify(command.evidence),
                  command.effectiveAt,
                  command.reversalOf ?? null,
                  reviewId,
                ],
              )
            ).rows[0]!;
            const before = new Map(locked.map((value) => [value.id, value]));
            for (const change of [...changes].sort((a, b) =>
              a.accountId < b.accountId ? -1 : 1,
            )) {
              const original = before.get(change.accountId)!;
              await tx.query(
                'INSERT INTO inventory_ledger_postings(tenant_id,entry_id,account_id,sku_id,unit,account_version,quantity,balance_before,balance_after) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                [
                  tenant,
                  command.id,
                  change.accountId,
                  change.address.skuId,
                  change.address.unit,
                  change.version,
                  change.quantity,
                  original.balance,
                  change.balance,
                ],
              );
              const updated = await tx.query(
                'UPDATE inventory_ledger_accounts SET balance=$3,version=$4 WHERE tenant_id=$1 AND id=$2 AND version=$5 AND balance=$6',
                [
                  tenant,
                  change.accountId,
                  change.balance,
                  change.version,
                  original.version,
                  original.balance,
                ],
              );
              if (updated.rowCount !== 1)
                throw new LedgerError(
                  'stale',
                  'An account changed before its posting committed.',
                );
              if (BigInt(change.version) % 100n === 0n)
                await checkpoint(tx, tenant, change.accountId, change.version);
            }

            if (command.purchaseReceipt) {
              const receipt = command.purchaseReceipt;
              const incomingDebit = command.postings
                .filter((p) => p.account.state === 'incoming')
                .reduce((sum, p) => sum - quantityUnits(p.quantity), 0n);
              if (incomingDebit > 0n)
                await tx.query(
                  'UPDATE inventory_purchase_incoming SET outstanding_quantity=outstanding_quantity-$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND purchase_order_id=$2 AND line_id=$3 AND outstanding_quantity>=$4',
                  [
                    tenant,
                    receipt.purchaseOrderId,
                    receipt.lineId,
                    decimalQuantity(incomingDebit),
                  ],
                );
              await tx.query(
                'INSERT INTO inventory_purchase_receipt_bookings(tenant_id,purchase_order_id,line_id,good,damaged,entry_id,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,purchase_order_id,line_id) DO UPDATE SET good=excluded.good,damaged=excluded.damaged,entry_id=excluded.entry_id,recorded_at=excluded.recorded_at',
                [
                  tenant,
                  receipt.purchaseOrderId,
                  receipt.lineId,
                  receipt.cumulativeGood,
                  receipt.cumulativeDamaged,
                  command.id,
                  recorded.recorded_at,
                ],
              );
            }

            return remember(command, hash, {
              id: command.id,
              key: command.key,
              commandHash: hash,
              entryId: command.id,
              reviewId,
              recordedAt: iso(recorded.recorded_at),
              accounts: changes.map((change) => ({
                id: change.accountId,
                address: change.address,
                balance: change.balance,
                version: change.version,
              })),
            });
          },
          zeroOpening: async (command, hash, reviewId, locked) =>
            remember(command, hash, {
              id: command.id,
              key: command.key,
              commandHash: hash,
              entryId: null,
              reviewId,
              recordedAt: new Date().toISOString(),
              accounts: locked,
            }),
          opened: async (skuId, locationId, unit) =>
            !!(
              await tx.query(
                'SELECT 1 FROM inventory_ledger_openings WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND unit=$4',
                [tenant, skuId, locationId, unit],
              )
            ).rowCount,
          rememberOpening: async (receipt, scope) => {
            await tx.query(
              'INSERT INTO inventory_ledger_openings(tenant_id,sku_id,location_id,unit,review_id,command_key,entry_id,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
              [
                tenant,
                scope.skuId,
                scope.locationId,
                scope.unit,
                receipt.reviewId,
                receipt.key,
                receipt.entryId,
                receipt.recordedAt,
              ],
            );
          },
        };

        return operation(port);
      }),
  };
}

async function checkpoint(
  tx: SqlTransaction,
  tenant: string,
  accountId: string,
  version: string,
) {
  await tx.query(
    `WITH previous AS (SELECT * FROM inventory_ledger_checkpoints WHERE tenant_id=$1 AND account_id=$2 AND version<$3 ORDER BY version DESC LIMIT 1),
  recent AS (SELECT COALESCE(sum(quantity) FILTER(WHERE effective_at IS NOT NULL),0) AS known,COALESCE(sum(quantity) FILTER(WHERE effective_at IS NULL),0) AS unknown,count(*) FILTER(WHERE effective_at IS NULL) AS unknown_count,max(effective_at) AS maximum_effective_at
   FROM inventory_ledger_postings WHERE tenant_id=$1 AND account_id=$2 AND account_version>COALESCE((SELECT version FROM previous),0) AND account_version<=$3)
  INSERT INTO inventory_ledger_checkpoints(tenant_id,account_id,version,known_quantity,unknown_quantity,unknown_count,maximum_effective_at,recorded_at)
  SELECT $1,$2,$3,COALESCE((SELECT known_quantity FROM previous),0)+r.known,COALESCE((SELECT unknown_quantity FROM previous),0)+r.unknown,COALESCE((SELECT unknown_count FROM previous),0)+r.unknown_count,
   greatest((SELECT maximum_effective_at FROM previous),r.maximum_effective_at),(SELECT recorded_at FROM inventory_ledger_postings WHERE tenant_id=$1 AND account_id=$2 AND account_version=$3) FROM recent r`,
    [tenant, accountId, version],
  );
}

async function stockEvidence(
  tx: SqlTransaction,
  tenant: string,
  snapshotId: string,
): Promise<StockEvidence | null> {
  const row = (
    await tx.query<{
      snapshot_id: string;
      document: unknown;
      status: string;
      granted: string[];
      catalog_parent: boolean | null;
      catalog_observed: Date | null;
    }>(
      `SELECT p.snapshot_id,current.document,i.document->>'status' AS status,
  COALESCE(i.document->'granted','[]'::jsonb) AS granted,k.parent AS catalog_parent,k.observed_at AS catalog_observed
  FROM inventory_snapshots original JOIN inventory_projections p ON p.tenant_id=original.tenant_id AND p.entity_id=original.entity_id AND p.connection_id=original.connection_id
  JOIN inventory_snapshots current ON current.tenant_id=p.tenant_id AND current.id=p.snapshot_id
  JOIN connector_installations i ON i.tenant_id=p.tenant_id AND i.id=p.connection_id
  LEFT JOIN LATERAL (SELECT (requires_components OR component_count>0) AS parent,observed_at FROM inventory_product_skus k JOIN inventory_projections kp ON kp.tenant_id=k.tenant_id AND kp.entity_id=k.product_id AND kp.connection_id=k.connection_id AND kp.snapshot_id=k.snapshot_id WHERE k.tenant_id=p.tenant_id AND k.connection_id=p.connection_id AND k.sku_id=current.sku_id ORDER BY k.observed_at DESC,k.product_id LIMIT 1 FOR SHARE OF kp) k ON true
  WHERE original.tenant_id=$1 AND original.id=$2 AND original.kind='position' FOR SHARE OF p`,
      [tenant, snapshotId],
    )
  ).rows[0];
  if (!row) return null;
  const value = snapshotSchema.parse(row.document);
  if (value.data.type !== 'position') return null;
  const data = value.data;
  const composition = data.composition;
  const parent =
    composition === null
      ? null
      : composition
        ? composition.requiresComponents || composition.hasComponents
        : row.catalog_observed &&
            Date.now() - row.catalog_observed.getTime() >= 0 &&
            Date.now() - row.catalog_observed.getTime() < 300_000
          ? row.catalog_parent
          : null;
  const fields =
    data.inventorySemantics === 'shopify/1'
      ? [
          data.onHand,
          data.available,
          data.reserved,
          data.committed,
          data.incoming,
          data.damaged,
          data.qualityControl,
          data.safetyStock,
        ]
      : [data.onHand, data.available, data.reserved];
  const check = (
    await tx.query<{ state: string; recorded_at: Date }>(
      `SELECT state,recorded_at FROM inventory_native_stock_read_checks WHERE tenant_id=$1 AND connection_id=$2 AND sku_id=$3 AND location_id=$4 AND unit=$5 ORDER BY recorded_at DESC,id DESC LIMIT 1`,
      [tenant, value.connectionId, data.skuId, data.locationId, data.unit],
    )
  ).rows[0];
  const unavailable =
    check?.state === 'unavailable' &&
    Date.parse(value.observedAt) <= check.recorded_at.getTime();
  const complete =
    !unavailable &&
    !value.deleted &&
    ['active', 'degraded'].includes(row.status) &&
    row.granted.includes('inventory.read') &&
    fields.every((field) => field !== null && field !== undefined) &&
    data.availabilityBasis !== 'unknown' &&
    (data.inventorySemantics !== 'shopify/1' ||
      (data.tracked === true &&
        typeof data.itemActive === 'boolean' &&
        typeof data.locationActive === 'boolean'));

  const channelReplica =
    ((
      await tx.query(
        `SELECT 1 FROM shopify_native_stock_replicas r
   JOIN inventory_stock_ownership_scopes o ON o.tenant_id=r.tenant_id AND o.location_id=r.location_id
    AND o.connection_id=r.connection_id AND o.version=r.scope_version AND o.mode='own'
   WHERE r.tenant_id=$1 AND r.connection_id=$2 AND r.sku_id=$3 AND r.location_id=$4 AND r.unit=$5 LIMIT 1`,
        [tenant, value.connectionId, data.skuId, data.locationId, data.unit],
      )
    ).rowCount ?? 0) > 0;

  return {
    snapshotId: row.snapshot_id,
    channelReplica,
    observationId: value.observationId,
    connectionId: value.connectionId,
    skuId: data.skuId,
    locationId: data.locationId,
    unit: data.unit,
    onHand: data.onHand,
    available: data.available,
    incoming: data.incoming ?? null,
    observedAt: value.observedAt,
    sourceUpdatedAt: value.sourceUpdatedAt,
    mappingVersion: value.mappingVersion,
    sourceRevision: value.sourceRevision,
    meaningHash: createHash('sha256').update(canonicalJson(data)).digest('hex'),
    channelState:
      data.inventorySemantics === 'shopify/1'
        ? {
            semantics: 'shopify/1',
            damaged: data.damaged ?? null,
            qualityControl: data.qualityControl ?? null,
            safetyStock: data.safetyStock ?? null,
            committed: data.committed ?? null,
            reserved: data.reserved,
            itemActive: data.itemActive ?? null,
            locationActive: data.locationActive ?? null,
            tracked: data.tracked ?? null,
          }
        : null,
    complete,
    bundleParent: parent,
  };
}
