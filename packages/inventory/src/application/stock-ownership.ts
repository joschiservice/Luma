import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
  type TenantContext,
} from '@luma/identity';

import { LedgerError, quantityUnits } from '../domain/ledger.js';
import {
  type OwnershipBinding,
  requireOwnershipTransition,
  type StockOwnershipMode,
} from '../domain/ownership.js';
import type { StockEvidence } from './ledger.js';
import type {
  NativeStockDependencies,
  NativeStockTransaction,
  OwnershipEvidence,
  StockOwnershipReview,
  StockOwnershipScope,
} from './native-stock.js';

/** Ownership binds reviewed ledger knowledge to one source/location and never sends provider writes. */
export function createStockOwnershipService(deps: NativeStockDependencies) {
  const now = deps.now ?? (() => new Date());

  async function access(context: TenantContext, review = false) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    requirePermission(fresh, 'inventory.read');
    requirePermission(fresh, review ? 'inventory.approve' : 'inventory.manage');
    if (!review) requirePermission(fresh, 'workspace.settings.manage');
    requireChangesAllowed(fresh);

    return fresh;
  }

  function requireFresh(
    source: StockEvidence | null,
  ): asserts source is StockEvidence & { onHand: string; available: string } {
    if (
      !source?.complete ||
      source.bundleParent !== false ||
      source.onHand === null ||
      source.available === null
    )
      throw new LedgerError(
        'source_incomplete',
        'Ownership needs complete stock-bearing source evidence.',
      );
    const age = now().getTime() - Date.parse(source.observedAt);
    if (!Number.isFinite(age) || age < 0 || age >= 300_000)
      throw new LedgerError(
        'evidence_stale',
        'Read and reconcile this source again before changing ownership.',
      );
  }

  function binding(
    evidence: OwnershipEvidence,
    connectionId: string,
    locationId: string,
    to: StockOwnershipMode,
  ): OwnershipBinding {
    if (evidence.unsettled)
      throw new LedgerError(
        'review_required',
        'Independently settle external effects before changing stock ownership.',
      );
    if (evidence.pools.length === 0 || evidence.pools.length > 5000)
      throw new LedgerError(
        'source_incomplete',
        'Ownership needs a bounded set of reviewed stock openings.',
      );
    if (
      to === 'observe' &&
      evidence.reservations.some(
        (reservation) => quantityUnits(reservation.remaining) > 0n,
      )
    )
      throw new LedgerError(
        'review_required',
        'Consume or release all remaining reservations before handback.',
      );
    const pools = evidence.pools
      .map((pool) => {
        const source = pool.source;
        requireFresh(source);
        if (source.channelReplica) {
          if (
            to !== 'observe' ||
            source.connectionId !== connectionId ||
            source.locationId !== locationId ||
            source.skuId !== pool.skuId ||
            source.unit !== pool.unit
          )
            throw new LedgerError(
              'review_required',
              'Channel evidence can only establish a reviewed handback baseline.',
            );
          const channel = source.channelState;
          const amount = (state: string) =>
            pool.accounts.find((account) => account.address.state === state)
              ?.balance;
          const matches = (state: string, value: string | null | undefined) =>
            value != null &&
            amount(state) !== undefined &&
            quantityUnits(amount(state)!) === quantityUnits(value);
          const physical = pool.accounts.filter((account) =>
            [
              'available',
              'reserved',
              'held',
              'quarantine',
              'damaged',
              'returned_inspection',
            ].includes(account.address.state),
          );
          if (
            !channel ||
            channel.committed == null ||
            channel.reserved == null ||
            quantityUnits(channel.committed) !== 0n ||
            quantityUnits(channel.reserved) !== 0n ||
            physical.length !== 6 ||
            physical.reduce(
              (sum, account) => sum + quantityUnits(account.balance),
              0n,
            ) !== quantityUnits(source.onHand) ||
            !matches('available', source.available) ||
            !matches('reserved', '0') ||
            !matches('returned_inspection', '0') ||
            !matches('in_transit', '0') ||
            !matches('incoming', source.incoming) ||
            !matches('held', channel.safetyStock) ||
            !matches('quarantine', channel.qualityControl) ||
            !matches('damaged', channel.damaged)
          )
            throw new LedgerError(
              'review_required',
              'Verify the full native baseline, clear provider commitments and align non-promisable states before handback. Activation and state moves require separate authority.',
            );

          return {
            skuId: pool.skuId,
            unit: pool.unit,
            openingReviewId: pool.openingReviewId,
            comparisonId: null,
            channelHandover: {
              snapshotId: source.snapshotId,
              meaningHash: source.meaningHash,
            },
            mappingVersion: source.mappingVersion,
            accountVersions: pool.accounts
              .map((account) => ({ id: account.id, version: account.version }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          };
        }
        const comparison = pool.comparison;
        if (!comparison || comparison.driftQuantity !== '0')
          throw new LedgerError(
            'stale',
            'Reconcile unexplained source drift before changing ownership.',
          );
        requireFresh(comparison.source);
        if (
          source.connectionId !== connectionId ||
          source.locationId !== locationId ||
          source.skuId !== pool.skuId ||
          source.unit !== pool.unit ||
          source.meaningHash !== comparison.source.meaningHash ||
          source.mappingVersion !== comparison.source.mappingVersion
        )
          throw new LedgerError(
            'stale',
            'Stock meaning or source mapping changed after reconciliation.',
          );
        const physical = pool.accounts.filter((account) =>
          [
            'available',
            'reserved',
            'held',
            'quarantine',
            'damaged',
            'returned_inspection',
          ].includes(account.address.state),
        );
        if (
          physical.length !== 6 ||
          physical.some(
            (account) =>
              !comparison.nativeVersions.some(
                (version) =>
                  version.accountId === account.id &&
                  version.version === account.version,
              ),
          ) ||
          comparison.nativeVersions.length !== physical.length
        )
          throw new LedgerError(
            'stale',
            'Native balances changed after reconciliation.',
          );
        if (to === 'own') {
          const channel = source.channelState;
          if (
            !channel ||
            channel.committed === null ||
            channel.reserved === null ||
            quantityUnits(channel.committed) !== 0n ||
            quantityUnits(channel.reserved) !== 0n
          )
            throw new LedgerError(
              'review_required',
              'Clear or explicitly migrate provider commitments before native ownership.',
            );
        }
        if (to === 'observe') {
          const available = pool.accounts.find(
            (account) => account.address.state === 'available',
          );
          if (
            !available ||
            quantityUnits(available.balance) !== quantityUnits(source.available)
          )
            throw new LedgerError(
              'stale',
              'Independently align provider availability before handback.',
            );
        }

        return {
          skuId: pool.skuId,
          unit: pool.unit,
          openingReviewId: pool.openingReviewId,
          comparisonId: comparison.id,
          mappingVersion: source.mappingVersion,
          accountVersions: pool.accounts
            .map((account) => ({ id: account.id, version: account.version }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        };
      })
      .sort(
        (a, b) =>
          a.skuId.localeCompare(b.skuId) || a.unit.localeCompare(b.unit),
      );

    return {
      connectionId,
      locationId,
      authorityRevision: evidence.authorityRevision,
      scopeVersion: evidence.scope.version,
      pools,
      reservationVersions: evidence.reservations
        .filter((reservation) => reservation.state === 'active')
        .map((reservation) => ({
          id: reservation.id,
          version: reservation.version,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  async function currentBinding(
    tx: NativeStockTransaction,
    review: StockOwnershipReview,
  ) {
    await tx.lockOwnership();
    const evidence = await tx.ownershipEvidence(
      review.binding.connectionId,
      review.binding.locationId,
    );
    if (
      evidence.scope.mode !== review.from ||
      deps.hash(
        binding(
          evidence,
          review.binding.connectionId,
          review.binding.locationId,
          review.to,
        ),
      ) !== deps.hash(review.binding)
    )
      throw new LedgerError(
        'stale',
        'Stock, reservations, mappings or authority changed after this ownership review.',
      );
  }

  return {
    /** Reads a retained location proposal without changing it or requiring write access. */
    async get(context: TenantContext, id: string) {
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      requirePermission(fresh, 'inventory.read');
      if (fresh.actor.id !== context.actor.id)
        throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');

      return deps.store.transaction(fresh, async (tx) => {
        const value = await tx.ownershipReview(id);
        if (!value)
          throw new IdentityError(
            404,
            'NOT_FOUND',
            'Stock ownership review not found',
          );

        return value;
      });
    },
    /** Prepares the next deliberate location step or an audited handback; it does not change authority. */
    async prepare(
      context: TenantContext,
      input: {
        id: string;
        key: string;
        connectionId: string;
        locationId: string;
        version: string;
        to: StockOwnershipMode;
        reason: string;
      },
    ): Promise<StockOwnershipReview> {
      const fresh = await access(context),
        intentHash = deps.hash(input);

      return deps.store.transaction(fresh, async (tx) => {
        await tx.lockOwnership();
        await tx.ledger.lockCommand(input.key);
        const previous = await tx.ownershipReviewByKey(input.key);
        if (previous) {
          if (previous.intentHash !== intentHash)
            throw new LedgerError(
              'changed_command',
              'This key prepared a different ownership transition.',
            );

          return previous;
        }
        if (
          (await tx.ledger.receipt(input.key)) ||
          (await tx.ledger.reviewByKey(input.key)) ||
          (await tx.ledger.comparison(input.key))
        )
          throw new LedgerError(
            'changed_command',
            'This key belongs to another stock operation.',
          );
        const evidence = await tx.ownershipEvidence(
          input.connectionId,
          input.locationId,
        );
        if (
          evidence.scope.lastTransitionId &&
          evidence.scope.connectionId !== input.connectionId
        )
          throw new LedgerError(
            'review_required',
            'This location retains a different source history. A source migration needs an explicit review of shipment identities before changing its binding.',
          );
        if (evidence.scope.version !== input.version)
          throw new LedgerError('stale', 'Location ownership changed.');
        requireOwnershipTransition(evidence.scope.mode, input.to);
        const value: StockOwnershipReview = {
          id: input.id,
          key: input.key,
          intentHash,
          from: evidence.scope.mode,
          to: input.to,
          binding: binding(
            evidence,
            input.connectionId,
            input.locationId,
            input.to,
          ),
          preparedBy: fresh.actor.id,
          reviewedBy: null,
          state: 'pending',
          reason: input.reason,
          createdAt: now().toISOString(),
          reviewedAt: null,
        };
        await tx.saveOwnershipReview(value);

        return value;
      });
    },
    /** Records another current member's decision over the exact location and stock binding. */
    async review(context: TenantContext, id: string, approved: boolean) {
      const fresh = await access(context, true);

      return deps.store.transaction(fresh, async (tx) => {
        await tx.ledger.lockCommand(`ownership-review:${id}`);
        const value = await tx.ownershipReview(id);
        if (!value)
          throw new IdentityError(
            404,
            'NOT_FOUND',
            'Stock ownership review not found',
          );
        if (value.preparedBy === fresh.actor.id)
          throw new LedgerError(
            'review_required',
            'Another member must review stock ownership.',
          );
        if (value.state !== 'pending') {
          if (
            value.reviewedBy === fresh.actor.id &&
            (value.state === 'approved') === approved
          )
            return value;
          throw new LedgerError(
            'stale',
            'This review already has a final decision.',
          );
        }
        if (approved) await currentBinding(tx, value);

        return tx.decideOwnership(value, approved, fresh.actor.id);
      });
    },
    /** Applies an approved versioned step after current membership, authority and independent evidence checks. */
    async apply(
      context: TenantContext,
      id: string,
    ): Promise<StockOwnershipScope> {
      const fresh = await access(context);

      return deps.store.transaction(fresh, async (tx) => {
        const value = await tx.ownershipReview(id);
        if (!value)
          throw new IdentityError(
            404,
            'NOT_FOUND',
            'Stock ownership review not found',
          );
        await tx.ledger.lockCommand(value.key);
        const receipt = await tx.transitionReceipt(value.id);
        if (receipt) return receipt;
        await tx.lockOwnership();
        await tx.scope(
          value.binding.connectionId,
          value.binding.locationId,
          true,
        );
        if (
          value.state !== 'approved' ||
          value.preparedBy !== fresh.actor.id ||
          !value.reviewedBy
        )
          throw new LedgerError(
            'review_required',
            'This ownership transition needs another member’s exact approval.',
          );
        const reviewer = await deps.reviewerContext(
          fresh.tenantId,
          value.reviewedBy,
          fresh.requestId,
        );
        requireTenant(reviewer, fresh.tenantId);
        requirePermission(reviewer, 'inventory.read');
        requirePermission(reviewer, 'inventory.approve');
        requireChangesAllowed(reviewer);
        await currentBinding(tx, value);

        return tx.transition(value);
      });
    },
  };
}
