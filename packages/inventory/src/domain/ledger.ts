/** Physical buckets retain exact SKU, location and unit identity. */
export const physicalStockStates = [
  'available',
  'reserved',
  'held',
  'quarantine',
  'damaged',
  'returned_inspection',
  'incoming',
  'in_transit',
] as const;

/** Virtual counterparties balance movements without inventing physical stock. */
export const counterpartyStockStates = [
  'supplier',
  'customer',
  'loss',
  'adjustment',
  'production',
] as const;

export type PhysicalStockState = (typeof physicalStockStates)[number];

type CounterpartyStockState = (typeof counterpartyStockStates)[number];

/** A connection-specific drift account shares the physical pool's explicit location context. */
export type AccountAddress = {
  skuId: string;
  locationId: string;
  unit: string;
} & (
  | { state: PhysicalStockState | CounterpartyStockState; connectionId?: never }
  | { state: 'external'; connectionId: string }
);

export type LedgerAccount = {
  id: string;
  address: AccountAddress;
  balance: string;
  version: string;
};

export type Posting = { account: AccountAddress; quantity: string };

type ExpectedAccount = {
  account: AccountAddress;
  balance: string;
  version: string;
};

/** Inputs retain business-effective time separately from the server's recording time. */
export interface PostingCommand {
  id: string;
  key: string;
  purpose:
    | 'opening'
    | 'movement'
    | 'correction'
    | 'reversal'
    | 'reservation'
    | 'release'
    | 'dispatch'
    | 'reconciliation'
    | 'production';
  reason: string;
  effectiveAt: string | null;
  evidence: {
    kind: 'observation' | 'review' | 'entry' | 'shipment';
    id: string;
  }[];
  postings: Posting[];
  expected: ExpectedAccount[];
  reversalOf?: string | undefined;
}

export type LedgerFailure =
  | 'invalid_quantity'
  | 'invalid_entry'
  | 'unbalanced'
  | 'stale'
  | 'insufficient_stock'
  | 'changed_command'
  | 'already_reversed'
  | 'review_required'
  | 'source_incomplete'
  | 'evidence_stale';

/** A rejected command has no committed postings or balance changes. */
export class LedgerError extends Error {
  constructor(
    public readonly code: LedgerFailure,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

const scale = 1_000_000n;
const maximum = 10n ** 24n - 1n;
const physical = new Set<string>(physicalStockStates);

/** Parses numeric(24,6) quantities without a floating-point conversion; excess precision is rejected. */
export function quantityUnits(value: string): bigint {
  if (!/^-?\d{1,18}(?:\.\d{1,6})?$/.test(value))
    throw new LedgerError(
      'invalid_quantity',
      'Use an exact quantity with at most six decimal places.',
    );
  const negative = value.startsWith('-'),
    [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const units = BigInt(whole!) * scale + BigInt(fraction.padEnd(6, '0'));
  if (units > maximum)
    throw new LedgerError(
      'invalid_quantity',
      'Quantity exceeds the ledger limit.',
    );

  return negative ? -units : units;
}

/** Serializes exact scaled units in canonical decimal form, with zero normalized to 0. */
export function decimalQuantity(units: bigint): string {
  const negative = units < 0n,
    absolute = negative ? -units : units;
  if (absolute > maximum)
    throw new LedgerError(
      'invalid_quantity',
      'Quantity exceeds the ledger limit.',
    );
  const fraction = String(absolute % scale)
    .padStart(6, '0')
    .replace(/0+$/, '');

  return `${negative ? '-' : ''}${absolute / scale}${fraction ? `.${fraction}` : ''}`;
}

/** Stable identity for comparisons; tenant context is supplied separately by the owning service. */
export function accountKey(account: AccountAddress): string {
  return JSON.stringify([
    account.skuId,
    account.locationId,
    account.unit,
    account.state,
    account.state === 'external' ? account.connectionId : null,
  ]);
}

/** Validates a balanced entry against every locked account and returns atomic balance/version changes. */
export function planPostings(
  command: PostingCommand,
  accounts: LedgerAccount[],
) {
  if (command.postings.length < 2 || command.postings.length > 5000)
    throw new LedgerError(
      'invalid_entry',
      'An entry needs between two and 5,000 postings.',
    );
  const current = new Map(
    accounts.map((account) => [accountKey(account.address), account]),
  );
  const expected = new Map(
    command.expected.map((account) => [accountKey(account.account), account]),
  );
  const addresses = command.postings.map((posting) =>
    accountKey(posting.account),
  );
  if (
    new Set(addresses).size !== addresses.length ||
    expected.size !== command.expected.length ||
    current.size !== accounts.length ||
    expected.size !== addresses.length ||
    current.size !== addresses.length
  )
    throw new LedgerError(
      'invalid_entry',
      'Every posting needs one distinct account and one expected balance/version.',
    );
  const totals = new Map<string, bigint>();
  const changes = command.postings.map((posting) => {
    const key = accountKey(posting.account),
      account = current.get(key),
      expectation = expected.get(key);
    if (!account || !expectation)
      throw new LedgerError(
        'invalid_entry',
        'Expected account identity does not match the postings.',
      );
    const delta = quantityUnits(posting.quantity);
    if (delta === 0n)
      throw new LedgerError(
        'invalid_entry',
        'Postings cannot have a zero quantity.',
      );
    if (
      !/^\d{1,19}$/.test(account.version) ||
      !/^\d{1,19}$/.test(expectation.version)
    )
      throw new LedgerError(
        'invalid_entry',
        'Account versions must be nonnegative integers.',
      );
    const version = BigInt(account.version);
    if (version >= 9_223_372_036_854_775_807n)
      throw new LedgerError('invalid_entry', 'Account version limit reached.');
    if (
      version !== BigInt(expectation.version) ||
      quantityUnits(account.balance) !== quantityUnits(expectation.balance)
    )
      throw new LedgerError(
        'stale',
        'An account changed after this command was prepared.',
      );
    const balance = quantityUnits(account.balance) + delta;
    if (physical.has(account.address.state) && balance < 0n)
      throw new LedgerError(
        'insufficient_stock',
        'Physical stock cannot be allocated or consumed below zero.',
      );
    const group = JSON.stringify([account.address.skuId, account.address.unit]);
    totals.set(group, (totals.get(group) ?? 0n) + delta);

    return {
      accountId: account.id,
      address: account.address,
      balance: decimalQuantity(balance),
      version: String(version + 1n),
      quantity: decimalQuantity(delta),
    };
  });
  if ([...totals.values()].some((total) => total !== 0n))
    throw new LedgerError(
      'unbalanced',
      'Postings must balance independently for each SKU and unit.',
    );

  return changes;
}
