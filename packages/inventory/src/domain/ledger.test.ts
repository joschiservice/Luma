import { expect, it } from 'vitest';

import {
  type AccountAddress,
  accountKey,
  decimalQuantity,
  type LedgerAccount,
  LedgerError,
  planPostings,
  type PostingCommand,
  quantityUnits,
} from './ledger.js';

const available: AccountAddress = {
  skuId: 'sku',
  locationId: 'location',
  unit: 'each',
  state: 'available',
};
const reserved: AccountAddress = { ...available, state: 'reserved' };
const accounts: LedgerAccount[] = [
  { id: 'a', address: available, balance: '10', version: '0' },
  { id: 'r', address: reserved, balance: '0', version: '0' },
];
const command: PostingCommand = {
  id: 'entry',
  key: 'command',
  purpose: 'reservation',
  reason: 'Allocate exact units',
  effectiveAt: null,
  evidence: [],
  postings: [
    { account: available, quantity: '-3.125001' },
    { account: reserved, quantity: '3.125001' },
  ],
  expected: accounts.map((account) => ({
    account: account.address,
    balance: account.balance,
    version: account.version,
  })),
};

it('preserves six-decimal quantities and large versions without mutating the locked state', () => {
  const locked = accounts.map((account) => ({
    ...account,
    version: '9007199254740992',
  }));
  const prepared = {
    ...command,
    expected: locked.map((account) => ({
      account: account.address,
      balance: account.balance,
      version: account.version,
    })),
  };
  expect(planPostings(prepared, locked)).toMatchObject([
    { accountId: 'a', balance: '6.874999', version: '9007199254740993' },
    { accountId: 'r', balance: '3.125001', version: '9007199254740993' },
  ]);
  expect(locked[0]?.balance).toBe('10');
  expect(decimalQuantity(quantityUnits('999999999999999999.999999'))).toBe(
    '999999999999999999.999999',
  );
  expect(decimalQuantity(quantityUnits('-0.000000'))).toBe('0');
});

it.each(['1.0000001', '1000000000000000000', 'NaN', '1e3'])(
  'rejects unsupported quantity %s instead of rounding it',
  (value) => {
    expect(() => quantityUnits(value)).toThrow(LedgerError);
  },
);

it('rejects overselling, stale versions and altered expected balances', () => {
  expect(() =>
    planPostings(
      {
        ...command,
        postings: [
          { account: available, quantity: '-11' },
          { account: reserved, quantity: '11' },
        ],
      },
      accounts,
    ),
  ).toThrow(expect.objectContaining({ code: 'insufficient_stock' }));
  expect(() =>
    planPostings(command, [{ ...accounts[0]!, version: '1' }, accounts[1]!]),
  ).toThrow(expect.objectContaining({ code: 'stale' }));
  expect(() =>
    planPostings(command, [{ ...accounts[0]!, balance: '9' }, accounts[1]!]),
  ).toThrow(expect.objectContaining({ code: 'stale' }));
});

it('balances each SKU and unit separately and does not merge locations or connections', () => {
  const other: AccountAddress = { ...reserved, skuId: 'other' };
  const cross = {
    ...command,
    postings: [command.postings[0]!, { account: other, quantity: '3.125001' }],
    expected: [
      command.expected[0]!,
      { account: other, balance: '0', version: '0' },
    ],
  };
  expect(() =>
    planPostings(cross, [accounts[0]!, { ...accounts[1]!, address: other }]),
  ).toThrow(expect.objectContaining({ code: 'unbalanced' }));
  expect(accountKey({ ...available, locationId: 'other' })).not.toBe(
    accountKey(available),
  );
  expect(
    accountKey({ ...available, state: 'external', connectionId: 'a' }),
  ).not.toBe(
    accountKey({ ...available, state: 'external', connectionId: 'b' }),
  );
});

it('permits signed virtual counterparties while requiring one exact expected account per posting', () => {
  const adjustment: AccountAddress = { ...available, state: 'adjustment' };
  const opening = {
    ...command,
    purpose: 'opening' as const,
    postings: [
      { account: available, quantity: '10' },
      { account: adjustment, quantity: '-10' },
    ],
    expected: [
      { account: available, balance: '0', version: '0' },
      { account: adjustment, balance: '0', version: '0' },
    ],
  };
  expect(
    planPostings(opening, [
      { ...accounts[0]!, balance: '0' },
      { id: 'v', address: adjustment, balance: '0', version: '0' },
    ]),
  ).toMatchObject([{ balance: '10' }, { balance: '-10' }]);
  expect(() =>
    planPostings(
      { ...command, expected: [command.expected[0]!, command.expected[0]!] },
      accounts,
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid_entry' }));
  expect(() =>
    planPostings(
      {
        ...command,
        postings: [
          { account: available, quantity: '0' },
          { account: reserved, quantity: '0' },
        ],
      },
      accounts,
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid_entry' }));
});
