import type { TenantContext } from '@luma/identity';

import type {
  AccountAddress,
  LedgerAccount,
  PhysicalStockState,
  PostingCommand,
} from '../domain/ledger.js';

/** A committed command result is retained unchanged for identical retries. */
export interface LedgerReceipt {
  id: string;
  key: string;
  commandHash: string;
  entryId: string | null;
  reviewId: string | null;
  recordedAt: string;
  accounts: LedgerAccount[];
}

/** Approval binds exact postings and source evidence; a final decision is retained. */
export interface LedgerReview {
  id: string;
  commandKey: string;
  commandHash: string;
  intentHash: string;
  command: PostingCommand;
  sources: StockEvidence[];
  preparedBy: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  state: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

/** Independent provider facts stay separate from native balances and order reservations. */
export interface StockEvidence {
  snapshotId: string;
  observationId: string;
  connectionId: string;
  skuId: string;
  locationId: string;
  unit: string;
  onHand: string | null;
  available: string | null;
  incoming: string | null;
  observedAt: string;
  sourceUpdatedAt: string | null;
  mappingVersion: string;
  sourceRevision: string | null;
  meaningHash: string;
  channelState?:
    | {
        semantics: 'shopify/1';
        committed: string | null;
        reserved: string | null;
        itemActive: boolean | null;
        locationActive: boolean | null;
        tracked: boolean | null;
      }
    | null
    | undefined;
  complete: boolean;
  bundleParent: boolean | null;
}

export interface OpeningInput {
  id: string;
  key: string;
  snapshotId: string;
  reason: string;
  balances: Partial<
    Record<
      Exclude<PhysicalStockState, 'reserved' | 'in_transit'>,
      string | undefined
    >
  >;
}

/** Historical quantities separate dated movements from movements with unknown effective time. */
export interface HistoricalBalance {
  account: Pick<LedgerAccount, 'id' | 'address'>;
  effectiveAt: string;
  recordedAt: string;
  maximumVersion: string;
  knownQuantity: string;
  unknownQuantity: string;
  unknownCount: string;
  recordedVersion: string;
}

/** A shadow comparison records provider on-hand evidence without changing any physical bucket. */
export interface ShadowComparison {
  id: string;
  key: string;
  source: StockEvidence;
  nativeQuantity: string;
  driftQuantity: string;
  nativeVersions: { accountId: string; version: string }[];
  entryId: string | null;
}

/** Continuous nonzero episodes are advisory evidence, not inferred lot age or physical loss. */
export interface LedgerAgingCandidate {
  account: LedgerAccount;
  entryId: string;
  since: string;
  basis: 'effective' | 'recorded';
  kind: 'transit' | 'inspection' | 'drift';
}

/** Inventory owns every write performed by this transaction. No provider effects are exposed. */
export interface LedgerTransaction {
  /** Serializes a stable command or preparation key within this tenant. */
  lockCommand(key: string): Promise<void>;
  /** Returns the original accepted result or rejects changed content. */
  receipt(key: string, hash?: string): Promise<LedgerReceipt | null>;
  /** Creates zero accounts in sorted identity order, then reads/locks the selected accounts. */
  accounts(
    addresses: AccountAddress[],
    lock: boolean,
  ): Promise<LedgerAccount[]>;
  /** Reads all physical buckets of this exact pool; a missing account has no balance. */
  pool(
    skuId: string,
    locationId: string,
    unit: string,
    lock: boolean,
  ): Promise<LedgerAccount[]>;
  /** Reads retained source evidence and establishes current identity, completeness and catalog role. */
  stockEvidence(snapshotId: string): Promise<StockEvidence | null>;
  review(id: string): Promise<LedgerReview | null>;
  reviewByKey(key: string): Promise<LedgerReview | null>;
  /** Returns immutable original content and whether it has already been reversed. */
  entry(
    id: string,
  ): Promise<{ command: PostingCommand; reversed: boolean } | null>;
  /** Reads a version-bounded effective/knowledge cutoff, using only eligible checkpoint prefixes. */
  historical(
    address: AccountAddress,
    effectiveAt: string,
    recordedAt: string,
    maximumVersion: string,
  ): Promise<HistoricalBalance | null>;
  /** Returns bounded evidence-backed continuous nonzero episodes. */
  aging(before: string, limit: number): Promise<LedgerAgingCandidate[]>;
  comparison(key: string): Promise<ShadowComparison | null>;
  saveComparison(value: ShadowComparison): Promise<void>;
  saveReview(review: LedgerReview): Promise<void>;
  decide(
    review: LedgerReview,
    approved: boolean,
    actorId: string,
  ): Promise<LedgerReview>;
  /** Appends the entry, exact postings, account changes, receipt and audit atomically. */
  commit(
    command: PostingCommand,
    hash: string,
    accounts: LedgerAccount[],
    reviewId: string | null,
  ): Promise<LedgerReceipt>;
  /** Retains a reviewed zero opening without inventing zero postings. */
  zeroOpening(
    command: PostingCommand,
    hash: string,
    reviewId: string,
    accounts: LedgerAccount[],
  ): Promise<LedgerReceipt>;
  /** A pool can be opened once; later corrections remain explicit movements. */
  opened(skuId: string, locationId: string, unit: string): Promise<boolean>;
  /** Binds the reviewed baseline to its exact pool after commit. */
  rememberOpening(
    receipt: LedgerReceipt,
    scope: { skuId: string; locationId: string; unit: string },
  ): Promise<void>;
}

export interface LedgerStore {
  transaction<T>(
    context: TenantContext,
    operation: (tx: LedgerTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface LedgerDependencies {
  store: LedgerStore;
  hash(value: unknown): string;
  validation: LedgerInputParser;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Resolves the original reviewer with current membership and grants before an unposted command. */
  reviewerContext(
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<TenantContext>;
  now?: () => Date;
}

/** Boundary parsers normalize exact quantities before application rules run. */
export interface LedgerInputParser {
  command(input: PostingCommand): PostingCommand;
  opening(input: OpeningInput): OpeningInput;
  historical(input: {
    account: AccountAddress;
    effectiveAt: string;
    recordedAt: string;
    maximumVersion: string;
  }): {
    account: AccountAddress;
    effectiveAt: string;
    recordedAt: string;
    maximumVersion: string;
  };
  aging(input: { before: string; limit: number }): {
    before: string;
    limit: number;
  };
  reconcile(input: { id: string; key: string; snapshotId: string }): {
    id: string;
    key: string;
    snapshotId: string;
  };
  reversal(input: {
    id: string;
    key: string;
    entryId: string;
    reason: string;
    effectiveAt: string | null;
  }): {
    id: string;
    key: string;
    entryId: string;
    reason: string;
    effectiveAt: string | null;
  };
}
