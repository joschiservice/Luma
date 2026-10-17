import {
  requireChangesAllowed,
  requirePermission,
  requireTenant,
  type TenantContext,
} from '@luma/identity';
import { forbidden } from '@luma/platform';

import {
  decimalQuantity,
  LedgerError,
  planPostings,
  type PostingCommand,
  quantityUnits,
} from '../domain/ledger.js';
import type { LedgerTransaction } from './ledger.js';

interface PurchaseIncomingLine {
  lineId: string;
  skuId: string;
  locationId: string;
  unit: string;
  expectedQuantity: string;
  /** Cumulative independently observed purchasing-system receipt; overlaps native booked receipts rather than adding to them. */
  providerReceivedQuantity?: string;
  scopeVersion: string;
  observedAt: string;
  expectedDate: string | null;
  dateConfidence: 'confirmed' | 'requested' | 'unknown';
}

export interface PurchaseIncomingSource {
  revision: string;
  evidenceRefs: string[];
  lines: PurchaseIncomingLine[];
  complete: boolean;
}

export interface PurchaseIncomingRecord extends PurchaseIncomingLine {
  purchaseOrderId: string;
  outstandingQuantity: string;
  sourceRevision: string;
  sourceRefs: string[];
  entryId: string | null;
}

interface IncomingTransaction {
  ledger: Pick<
    LedgerTransaction,
    'opened' | 'lockCommand' | 'accounts' | 'receipt' | 'commit'
  >;
  /** Acquires the order-level native receipt lock, procurement snapshot lock and relevant ownership rows. */
  source(orderId: string): Promise<PurchaseIncomingSource | null>;
  records(orderId: string): Promise<PurchaseIncomingRecord[]>;
  booked(orderId: string, lineId: string): Promise<string>;
  save(record: PurchaseIncomingRecord): Promise<void>;
}

export interface PurchaseIncomingStore {
  transaction<T>(
    context: TenantContext,
    orderId: string,
    operation: (tx: IncomingTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Projects independently verified purchasing expectations into Inventory's incoming bucket without changing sellable stock. */
export function createPurchaseIncoming(deps: {
  store: PurchaseIncomingStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  enabled(context: TenantContext): Promise<boolean>;
  hash(value: unknown): string;
  uuid(key: string): string;
}) {
  return {
    /** Appends balanced incoming changes after a procurement event; retries reuse owner evidence and never touch available stock. */
    async reconcile(context: TenantContext, purchaseOrderId: string) {
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      if (fresh.actor.id !== context.actor.id)
        throw forbidden('Actor changed.');
      requireChangesAllowed(fresh);
      requirePermission(fresh, 'inventory.read');
      requirePermission(fresh, 'procurement.read');
      if (!(await deps.enabled(fresh)))
        return { updated: 0, unavailable: [] as string[] };

      return deps.store.transaction(fresh, purchaseOrderId, async (tx) => {
        const source = await tx.source(purchaseOrderId);
        if (!source?.complete)
          return { updated: 0, unavailable: [purchaseOrderId] };
        const records = await tx.records(purchaseOrderId);
        const ids = new Set([
          ...source.lines.map((line) => line.lineId),
          ...records.map((line) => line.lineId),
        ]);
        let updated = 0;
        const unavailable: string[] = [];
        for (const lineId of [...ids].sort()) {
          const previous = records.find((record) => record.lineId === lineId);
          const line =
            source.lines.find((value) => value.lineId === lineId) ??
            (previous
              ? {
                  ...previous,
                  expectedQuantity: '0',
                  expectedDate: null,
                  dateConfidence: 'unknown' as const,
                }
              : null);
          if (!line) continue;
          if (
            previous &&
            (previous.skuId !== line.skuId ||
              previous.locationId !== line.locationId ||
              previous.unit !== line.unit ||
              previous.scopeVersion !== line.scopeVersion)
          )
            throw new LedgerError(
              'stale',
              'Incoming stock ownership or mappings changed. Review the stock pool.',
            );
          if (
            !(await tx.ledger.opened(line.skuId, line.locationId, line.unit))
          ) {
            unavailable.push(lineId);
            continue;
          }
          const expected = quantityUnits(line.expectedQuantity);
          if (expected < 0n)
            throw new LedgerError(
              'invalid_quantity',
              'Incoming expectation must be nonnegative.',
            );
          const booked = quantityUnits(
            await tx.booked(purchaseOrderId, lineId),
          );
          const providerReceived = quantityUnits(
            line.providerReceivedQuantity ?? '0',
          );
          if (providerReceived < 0n)
            throw new LedgerError(
              'invalid_quantity',
              'Received quantity must be nonnegative.',
            );
          const received =
            booked > providerReceived ? booked : providerReceived;
          const outstanding = expected > received ? expected - received : 0n;
          const before = quantityUnits(previous?.outstandingQuantity ?? '0');
          const delta = outstanding - before;
          if (delta === 0n && previous?.sourceRevision === source.revision)
            continue;
          let entryId = previous?.entryId ?? null;
          if (delta !== 0n) {
            const key = `purchase-incoming:${purchaseOrderId}:${lineId}:${deps.hash({ revision: source.revision, outstanding: decimalQuantity(outstanding), before: decimalQuantity(before) })}`;
            await tx.ledger.lockCommand(key);
            const address = {
              skuId: line.skuId,
              locationId: line.locationId,
              unit: line.unit,
            };
            const postings = [
              {
                account: { ...address, state: 'incoming' as const },
                quantity: decimalQuantity(delta),
              },
              {
                account: { ...address, state: 'supplier' as const },
                quantity: decimalQuantity(-delta),
              },
            ];
            const accounts = await tx.ledger.accounts(
              postings.map((posting) => posting.account),
              true,
            );
            const command: PostingCommand = {
              id: deps.uuid(key),
              key,
              purpose: 'movement',
              reason:
                'Supplier arrival expectation updated from independently verified purchasing evidence',
              effectiveAt: null,
              evidence: source.evidenceRefs.map((id) => ({
                kind: 'observation',
                id,
              })),
              postings,
              expected: accounts.map((account) => ({
                account: account.address,
                balance: account.balance,
                version: account.version,
              })),
            };
            const receipt = await tx.ledger.receipt(key, deps.hash(command));
            planPostings(command, accounts);
            entryId =
              receipt?.entryId ??
              (
                await tx.ledger.commit(
                  command,
                  deps.hash(command),
                  accounts,
                  null,
                )
              ).entryId;
            updated++;
          }
          await tx.save({
            ...line,
            purchaseOrderId,
            outstandingQuantity: decimalQuantity(outstanding),
            sourceRevision: source.revision,
            sourceRefs: source.evidenceRefs,
            entryId,
          });
        }

        return { updated, unavailable };
      });
    },
  };
}
