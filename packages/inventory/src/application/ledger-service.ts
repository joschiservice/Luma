import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
  type TenantContext,
} from '@luma/identity';
import { canonicalJson } from '@luma/platform';

import {
  type AccountAddress,
  accountKey,
  decimalQuantity,
  LedgerError,
  physicalStockStates,
  planPostings,
  type Posting,
  type PostingCommand,
  quantityUnits,
} from '../domain/ledger.js';
import type {
  HistoricalBalance,
  LedgerAgingCandidate,
  LedgerDependencies,
  LedgerReview,
  LedgerTransaction,
  OpeningInput,
  ShadowComparison,
  StockEvidence,
} from './ledger.js';

const reviewId = (
  hash: (value: unknown) => string,
  tenantId: string,
  key: string,
) => {
  const value = hash(['inventory-review', tenantId, key]);

  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-${((parseInt(value.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${value.slice(18, 20)}-${value.slice(20, 32)}`;
};
const sourceShape = (source: StockEvidence) => [
  source.connectionId,
  source.skuId,
  source.locationId,
  source.unit,
  source.onHand,
  source.available,
  source.incoming,
  source.mappingVersion,
  source.meaningHash,
  source.complete,
  source.bundleParent,
];

/** Supplies tenant-scoped reviewed openings and owner-only movements; it exposes no provider writes. */
export function createLedgerService(deps: LedgerDependencies) {
  const { hash, validation } = deps;
  const now = deps.now ?? (() => new Date());

  async function access(
    context: TenantContext,
    permission: 'inventory.read' | 'inventory.manage' | 'inventory.approve',
    write = false,
  ) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    requirePermission(fresh, 'inventory.read');
    requirePermission(fresh, permission);
    if (write) requireChangesAllowed(fresh);

    return fresh;
  }

  function requireSource(
    source: StockEvidence | null,
  ): asserts source is StockEvidence & {
    onHand: string;
    available: string;
    bundleParent: false;
    complete: true;
  } {
    if (
      !source ||
      !source.complete ||
      source.onHand === null ||
      source.available === null ||
      source.bundleParent !== false
    )
      throw new LedgerError(
        'source_incomplete',
        'An opening requires complete physical stock evidence and a known stock-bearing SKU.',
      );
    const age = now().getTime() - Date.parse(source.observedAt);
    if (age < 0 || age >= 300_000)
      throw new LedgerError(
        'evidence_stale',
        'Read the source again before reviewing stock.',
      );
  }

  async function currentSources(tx: LedgerTransaction, review: LedgerReview) {
    for (const original of review.sources) {
      const current = await tx.stockEvidence(original.snapshotId);
      requireSource(current);
      if (
        canonicalJson(sourceShape(current)) !==
        canonicalJson(sourceShape(original))
      )
        throw new LedgerError(
          'stale',
          'Source quantity, meaning or mapping changed after preparation.',
        );
    }
  }

  async function apply(
    tx: LedgerTransaction,
    command: PostingCommand,
    commandHash: string,
    reviewId: string | null,
  ) {
    const previous = await tx.receipt(command.key, commandHash);
    if (previous) return previous;
    if (
      command.effectiveAt &&
      Date.parse(command.effectiveAt) > now().getTime()
    )
      throw new LedgerError(
        'invalid_entry',
        'Effective time cannot be in the future.',
      );
    for (const scope of new Map(
      command.postings.map((posting) => [
        JSON.stringify([
          posting.account.skuId,
          posting.account.locationId,
          posting.account.unit,
        ]),
        posting.account,
      ]),
    ).values())
      if (
        command.purpose !== 'opening' &&
        !(await tx.opened(scope.skuId, scope.locationId, scope.unit))
      )
        throw new LedgerError(
          'review_required',
          'Review an opening before posting movements in this pool.',
        );
    const accounts = await tx.accounts(
      command.postings.map((posting) => posting.account),
      true,
    );
    planPostings(command, accounts);

    return tx.commit(command, commandHash, accounts, reviewId);
  }

  return {
    /** Reads dated balances at an explicit knowledge/version cutoff; unknown effective times stay separate. */
    async historical(
      context: TenantContext,
      input: {
        account: AccountAddress;
        effectiveAt: string;
        recordedAt: string;
        maximumVersion: string;
      },
    ): Promise<HistoricalBalance | null> {
      const fresh = await access(context, 'inventory.read'),
        value = validation.historical(input);

      return deps.store.transaction(fresh, (tx) =>
        tx.historical(
          value.account,
          value.effectiveAt,
          value.recordedAt,
          value.maximumVersion,
        ),
      );
    },
    /** Lists bounded transit, inspection and drift candidates based on continuous nonzero episodes. */
    async aging(
      context: TenantContext,
      input: { before: string; limit: number },
    ): Promise<LedgerAgingCandidate[]> {
      const fresh = await access(context, 'inventory.read'),
        value = validation.aging(input);

      return deps.store.transaction(fresh, (tx) =>
        tx.aging(value.before, value.limit),
      );
    },
    /** Reconciles fresh provider on-hand against native physical stock, posting only explicit virtual drift. */
    async reconcile(
      context: TenantContext,
      input: { id: string; key: string; snapshotId: string },
    ): Promise<ShadowComparison> {
      const fresh = await access(context, 'inventory.manage', true),
        value = validation.reconcile(input);

      return deps.store.transaction(fresh, async (tx) => {
        await tx.lockCommand(value.key);
        const previous = await tx.comparison(value.key);
        if (previous) {
          if (
            previous.id !== value.id ||
            previous.source.snapshotId !== value.snapshotId
          )
            throw new LedgerError(
              'changed_command',
              'This key already compared different stock evidence.',
            );

          return previous;
        }
        if ((await tx.receipt(value.key)) || (await tx.reviewByKey(value.key)))
          throw new LedgerError(
            'changed_command',
            'This key already belongs to a different stock command.',
          );
        const source = await tx.stockEvidence(value.snapshotId);
        requireSource(source);
        if (source.snapshotId !== value.snapshotId)
          throw new LedgerError(
            'stale',
            'Reconcile the latest source snapshot.',
          );
        const base = {
          skuId: source.skuId,
          locationId: source.locationId,
          unit: source.unit,
        };
        if (!(await tx.opened(base.skuId, base.locationId, base.unit)))
          throw new LedgerError(
            'review_required',
            'Review an opening before reconciliation.',
          );
        // Lock every participating physical and virtual account in one global order.
        const addresses: AccountAddress[] = [
          ...physicalStockStates.map((state) => ({ ...base, state })),
          { ...base, state: 'external', connectionId: source.connectionId },
          { ...base, state: 'adjustment' },
        ];
        const accounts = await tx.accounts(addresses, true);
        const native = accounts.filter(
          (account) =>
            physicalStockStates.some(
              (state) => state === account.address.state,
            ) && !['incoming', 'in_transit'].includes(account.address.state),
        );
        const nativeQuantity = decimalQuantity(
          native.reduce(
            (total, account) => total + quantityUnits(account.balance),
            0n,
          ),
        );
        // Evidence must include every currently known physical posting, including backdated movements.
        for (const account of native) {
          const history = await tx.historical(
            account.address,
            now().toISOString(),
            source.observedAt,
            account.version,
          );
          if (!history || history.recordedVersion !== account.version)
            throw new LedgerError(
              'evidence_stale',
              'Read the provider after the latest native stock change.',
            );
        }
        const driftQuantity = decimalQuantity(
          quantityUnits(source.onHand) - quantityUnits(nativeQuantity),
        );
        const external = accounts.find(
            (account) => account.address.state === 'external',
          )!,
          adjustment = accounts.find(
            (account) => account.address.state === 'adjustment',
          )!;
        const difference =
          quantityUnits(driftQuantity) - quantityUnits(external.balance);
        let entryId: string | null = null;
        if (difference !== 0n) {
          const command: PostingCommand = {
            id: value.id,
            key: value.key,
            purpose: 'reconciliation',
            reason: 'Fresh shadow on-hand reconciliation',
            effectiveAt: source.observedAt,
            evidence: [{ kind: 'observation', id: source.observationId }],
            postings: [
              {
                account: external.address,
                quantity: decimalQuantity(difference),
              },
              {
                account: adjustment.address,
                quantity: decimalQuantity(-difference),
              },
            ],
            expected: [external, adjustment].map((account) => ({
              account: account.address,
              balance: account.balance,
              version: account.version,
            })),
          };
          entryId = (
            await tx.commit(
              command,
              hash(command),
              [external, adjustment],
              null,
            )
          ).entryId;
        }
        const comparison: ShadowComparison = {
          id: value.id,
          key: value.key,
          source,
          nativeQuantity,
          driftQuantity,
          nativeVersions: native.map((account) => ({
            accountId: account.id,
            version: account.version,
          })),
          entryId,
        };
        await tx.saveComparison(comparison);

        return comparison;
      });
    },
    /** Prepares an explicit correction or production movement, binding exact balances and fresh source identities. */
    async prepareChange(
      context: TenantContext,
      input: PostingCommand,
      snapshotIds: string[],
    ): Promise<LedgerReview> {
      const fresh = await access(context, 'inventory.manage', true),
        command: PostingCommand = validation.command(input);
      if (
        !['correction', 'production'].includes(command.purpose) ||
        command.reversalOf
      )
        throw new LedgerError(
          'invalid_entry',
          'Use a correction, production movement or the dedicated reversal preparation.',
        );
      if (
        snapshotIds.length === 0 ||
        snapshotIds.length > 128 ||
        new Set(snapshotIds).size !== snapshotIds.length
      )
        throw new LedgerError(
          'source_incomplete',
          'Bind distinct source snapshots for the changed stock pools.',
        );
      const intentHash = hash({ command, snapshotIds });

      return deps.store.transaction(fresh, async (tx) => {
        await tx.lockCommand(command.key);
        const previous = await tx.reviewByKey(command.key);
        if (previous) {
          if (previous.intentHash !== intentHash)
            throw new LedgerError(
              'changed_command',
              'This key prepared different stock.',
            );

          return previous;
        }
        if (
          (await tx.receipt(command.key)) ||
          (await tx.comparison(command.key))
        )
          throw new LedgerError(
            'changed_command',
            'This key belongs to another stock command.',
          );
        const sources: StockEvidence[] = [];
        for (const id of snapshotIds) {
          const source = await tx.stockEvidence(id);
          requireSource(source);
          sources.push(source);
        }
        for (const posting of command.postings) {
          if (
            !sources.some(
              (source) =>
                source.skuId === posting.account.skuId &&
                source.locationId === posting.account.locationId &&
                source.unit === posting.account.unit,
            )
          )
            throw new LedgerError(
              'source_incomplete',
              'Every changed pool needs source evidence.',
            );
          if (
            !(await tx.opened(
              posting.account.skuId,
              posting.account.locationId,
              posting.account.unit,
            ))
          )
            throw new LedgerError(
              'review_required',
              'Review an opening before changing this pool.',
            );
        }
        planPostings(
          command,
          await tx.accounts(
            command.postings.map((posting) => posting.account),
            true,
          ),
        );
        const review: LedgerReview = {
          id: reviewId(hash, fresh.tenantId, command.key),
          commandKey: command.key,
          commandHash: hash(command),
          intentHash,
          command,
          sources,
          preparedBy: fresh.actor.id,
          reviewedBy: null,
          reviewedAt: null,
          state: 'pending',
          createdAt: now().toISOString(),
        };
        await tx.saveReview(review);

        return review;
      });
    },
    /** Reverses every original posting exactly; current versions and nonnegative physical balances still apply. */
    async prepareReversal(
      context: TenantContext,
      input: {
        id: string;
        key: string;
        entryId: string;
        reason: string;
        effectiveAt: string | null;
      },
    ): Promise<LedgerReview> {
      const fresh = await access(context, 'inventory.manage', true);
      input = validation.reversal(input);
      const intentHash = hash(input);

      return deps.store.transaction(fresh, async (tx) => {
        await tx.lockCommand(input.key);
        const previous = await tx.reviewByKey(input.key);
        if (previous) {
          if (previous.intentHash !== intentHash)
            throw new LedgerError(
              'changed_command',
              'This key prepared a different reversal.',
            );

          return previous;
        }
        if ((await tx.receipt(input.key)) || (await tx.comparison(input.key)))
          throw new LedgerError(
            'changed_command',
            'This key belongs to another stock command.',
          );
        const original = await tx.entry(input.entryId);
        if (!original)
          throw new IdentityError(404, 'NOT_FOUND', 'Stock entry not found');
        if (original.reversed || original.command.purpose === 'reversal')
          throw new LedgerError(
            'already_reversed',
            'This entry has already been reversed or is itself a reversal.',
          );
        const accounts = await tx.accounts(
          original.command.postings.map((posting) => posting.account),
          true,
        );
        const command: PostingCommand = validation.command({
          id: input.id,
          key: input.key,
          purpose: 'reversal',
          reason: input.reason,
          effectiveAt: input.effectiveAt,
          reversalOf: input.entryId,
          evidence: [{ kind: 'entry', id: input.entryId }],
          postings: original.command.postings.map((posting) => ({
            account: posting.account,
            quantity: decimalQuantity(-quantityUnits(posting.quantity)),
          })),
          expected: accounts.map((account) => ({
            account: account.address,
            balance: account.balance,
            version: account.version,
          })),
        });
        planPostings(command, accounts);
        const review: LedgerReview = {
          id: reviewId(hash, fresh.tenantId, input.key),
          commandKey: input.key,
          commandHash: hash(command),
          intentHash,
          command,
          sources: [],
          preparedBy: fresh.actor.id,
          reviewedBy: null,
          reviewedAt: null,
          state: 'pending',
          createdAt: now().toISOString(),
        };
        await tx.saveReview(review);

        return review;
      });
    },
    /** Internal Inventory usecases post expected-version movements; reviewed purposes use postReviewed. */
    async post(context: TenantContext, input: PostingCommand) {
      const fresh = await access(context, 'inventory.manage', true),
        command: PostingCommand = validation.command(input);
      if (
        ['opening', 'correction', 'reversal', 'production'].includes(
          command.purpose,
        )
      )
        throw new LedgerError(
          'review_required',
          'Prepare and review this stock change first.',
        );
      const commandHash = hash(command);

      return deps.store.transaction(fresh, async (tx) => {
        await tx.lockCommand(command.key);
        if (
          (await tx.reviewByKey(command.key)) ||
          (await tx.comparison(command.key))
        )
          throw new LedgerError(
            'changed_command',
            'This key belongs to reviewed stock or a shadow comparison.',
          );

        return apply(tx, command, commandHash, null);
      });
    },
    /** Prepares a first, non-authoritative baseline; committed/reserved provider quantities create no order reservations. */
    async prepareOpening(
      context: TenantContext,
      input: OpeningInput,
    ): Promise<LedgerReview> {
      const fresh = await access(context, 'inventory.manage', true),
        value = validation.opening(input),
        intentHash = hash(value);

      return deps.store.transaction(fresh, async (tx) => {
        await tx.lockCommand(value.key);
        const previous = await tx.reviewByKey(value.key);
        if (previous) {
          if (previous.intentHash !== intentHash)
            throw new LedgerError(
              'changed_command',
              'This key already prepared different stock.',
            );

          return previous;
        }
        if ((await tx.receipt(value.key)) || (await tx.comparison(value.key)))
          throw new LedgerError(
            'changed_command',
            'This key belongs to another stock command.',
          );
        const source = await tx.stockEvidence(value.snapshotId);
        requireSource(source);
        if (await tx.opened(source.skuId, source.locationId, source.unit))
          throw new LedgerError(
            'invalid_entry',
            'This stock pool already has an opening. Use a reviewed correction.',
          );
        const base = {
          skuId: source.skuId,
          locationId: source.locationId,
          unit: source.unit,
        };
        const balances = physicalStockStates.map((state) => ({
          state,
          units: quantityUnits(
            state === 'reserved' || state === 'in_transit'
              ? '0'
              : (value.balances[state] ?? '0'),
          ),
        }));
        if (balances.some((balance) => balance.units < 0n))
          throw new LedgerError(
            'invalid_quantity',
            'Opening quantities cannot be negative.',
          );
        const onHand = balances
          .filter(
            (balance) => !['incoming', 'in_transit'].includes(balance.state),
          )
          .reduce((sum, balance) => sum + balance.units, 0n);
        const available = balances.find(
          (balance) => balance.state === 'available',
        )!.units;
        if (
          onHand !== quantityUnits(source.onHand) ||
          available >
            (quantityUnits(source.available) < 0n
              ? 0n
              : quantityUnits(source.available))
        )
          throw new LedgerError(
            'stale',
            'The physical opening must match reported on-hand stock and must not exceed reported availability.',
          );
        const incoming = balances.find(
          (balance) => balance.state === 'incoming',
        )!.units;
        if (
          incoming > 0n &&
          (source.incoming === null ||
            incoming > quantityUnits(source.incoming))
        )
          throw new LedgerError(
            'source_incomplete',
            'The source did not establish these incoming units.',
          );
        const addresses: AccountAddress[] = [
          ...physicalStockStates.map((state) => ({ ...base, state })),
          { ...base, state: 'adjustment' },
        ];
        const accounts = await tx.accounts(addresses, true);
        if (
          accounts.some(
            (account) => account.balance !== '0' || account.version !== '0',
          )
        )
          throw new LedgerError(
            'stale',
            'An opening requires unused zero accounts.',
          );
        const total = balances.reduce(
          (sum, balance) => sum + balance.units,
          0n,
        );
        const postings: Posting[] = balances
          .filter((balance) => balance.units !== 0n)
          .map((balance) => ({
            account: { ...base, state: balance.state },
            quantity: decimalQuantity(balance.units),
          }));
        if (total !== 0n)
          postings.push({
            account: { ...base, state: 'adjustment' },
            quantity: decimalQuantity(-total),
          });
        const selected = new Set(
          postings.map((posting) => accountKey(posting.account)),
        );
        const command: PostingCommand = {
          id: value.id,
          key: value.key,
          purpose: 'opening',
          reason: value.reason,
          effectiveAt: source.observedAt,
          evidence: [{ kind: 'observation', id: source.observationId }],
          postings,
          expected: accounts
            .filter((account) => selected.has(accountKey(account.address)))
            .map((account) => ({
              account: account.address,
              balance: account.balance,
              version: account.version,
            })),
        };
        const review: LedgerReview = {
          id: reviewId(hash, fresh.tenantId, value.key),
          commandKey: value.key,
          commandHash: hash(command),
          intentHash,
          command,
          sources: [source],
          preparedBy: fresh.actor.id,
          reviewedBy: null,
          reviewedAt: null,
          state: 'pending',
          createdAt: now().toISOString(),
        };
        await tx.saveReview(review);

        return review;
      });
    },
    /** Records another current member's decision; identical decisions retain their original evidence. */
    async review(context: TenantContext, id: string, approved: boolean) {
      const fresh = await access(context, 'inventory.approve', true);

      return deps.store.transaction(fresh, async (tx) => {
        await tx.lockCommand(`review:${id}`);
        const review = await tx.review(id);
        if (!review)
          throw new IdentityError(404, 'NOT_FOUND', 'Stock review not found');
        if (review.preparedBy === fresh.actor.id)
          throw new LedgerError(
            'review_required',
            'Another member must review this stock change.',
          );
        if (review.state !== 'pending') {
          if (
            review.reviewedBy === fresh.actor.id &&
            (review.state === 'approved') === approved
          )
            return review;
          throw new LedgerError(
            'stale',
            'This review already has a final decision.',
          );
        }
        if (approved) await currentSources(tx, review);

        return tx.decide(review, approved, fresh.actor.id);
      });
    },
    /** Applies exact approved content after rechecking source evidence, reviewer rights and every account version. */
    async postReviewed(context: TenantContext, id: string) {
      const fresh = await access(context, 'inventory.manage', true);

      return deps.store.transaction(fresh, async (tx) => {
        const review = await tx.review(id);
        if (!review)
          throw new IdentityError(404, 'NOT_FOUND', 'Stock review not found');
        await tx.lockCommand(review.command.key);
        const receipt = await tx.receipt(
          review.command.key,
          review.commandHash,
        );
        if (receipt) return receipt;
        if (
          review.preparedBy !== fresh.actor.id ||
          review.state !== 'approved' ||
          !review.reviewedBy
        )
          throw new LedgerError(
            'review_required',
            'This exact command needs another member’s approval.',
          );
        const reviewer = await deps.reviewerContext(
          fresh.tenantId,
          review.reviewedBy,
          fresh.requestId,
        );
        requireTenant(reviewer, fresh.tenantId);
        requirePermission(reviewer, 'inventory.read');
        requirePermission(reviewer, 'inventory.approve');
        requireChangesAllowed(reviewer);
        await currentSources(tx, review);
        const command: PostingCommand = validation.command(review.command);
        if (hash(command) !== review.commandHash)
          throw new LedgerError(
            'changed_command',
            'The prepared stock command changed.',
          );
        if (command.reversalOf) {
          const original = await tx.entry(command.reversalOf);
          if (!original || original.reversed)
            throw new LedgerError(
              'already_reversed',
              'This stock entry already has a reversal.',
            );
        }
        if (command.purpose === 'opening') {
          const source = review.sources[0]!;
          const physical = await tx.pool(
            source.skuId,
            source.locationId,
            source.unit,
            true,
          );
          if (
            (await tx.opened(source.skuId, source.locationId, source.unit)) ||
            physical.some(
              (account) =>
                physicalStockStates.some(
                  (state) => state === account.address.state,
                ) &&
                (account.version !== '0' || account.balance !== '0'),
            )
          )
            throw new LedgerError(
              'stale',
              'This pool changed after its opening was prepared.',
            );
          const result = command.postings.length
            ? await apply(tx, command, review.commandHash, review.id)
            : await tx.zeroOpening(
                command,
                review.commandHash,
                review.id,
                physical,
              );
          await tx.rememberOpening(result, source);

          return result;
        }

        return apply(tx, command, review.commandHash, review.id);
      });
    },
  };
}

/** Inventory's controlled shadow-ledger application contract. */
export type LedgerService = ReturnType<typeof createLedgerService>;
