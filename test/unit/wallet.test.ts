import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WalletLedgerEntry, LedgerDirection } from '../../src/domain/ledger-entry';
import { CurrencyMismatchError, InsufficientFundsError, ValidationError } from '../../src/domain/errors';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const open = (initial = '100.00') =>
  Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl(initial),
    openingTransactionId: 't0',
    openingEntryId: 'e0',
    now: new Date(),
  });

describe('Wallet', () => {
  test('opens at version 1 with an OPENING credit entry when balance > 0', () => {
    const { wallet, openingEntry } = open();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('100.00');
  });

  test('zero initial balance produces no ledger entry', () => {
    const { wallet, openingEntry } = open('0.00');
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test('debit returns a balanced entry and bumps version', () => {
    const { wallet } = open();
    const e = wallet.debit(brl('30.00'), 't1', 'e1', new Date());
    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(e.isBalanced()).toBe(true);
    expect(e.balanceBefore.toString()).toBe('100.00');
    expect(e.balanceAfter.toString()).toBe('70.00');
  });

  test('credit increases balance', () => {
    const { wallet } = open();
    wallet.credit(brl('5.50'), 't1', 'e1', new Date());
    expect(wallet.balance.toString()).toBe('105.50');
  });

  test('never goes negative and a failed debit changes nothing', () => {
    const { wallet } = open();
    expect(() => wallet.debit(brl('100.01'), 't1', 'e1', new Date())).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('can drain exactly to zero', () => {
    const { wallet } = open();
    wallet.debit(brl('100.00'), 't1', 'e1', new Date());
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rejects another currency and non-positive amounts, version untouched', () => {
    const { wallet } = open();
    expect(() => wallet.debit(Money.from({ amount: '1.00', currency: 'USD' }), 't', 'e', new Date())).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.credit(brl('0.00'), 't', 'e', new Date())).toThrow(ValidationError);
    expect(wallet.version).toBe(1);
  });

  test('rehydrate does not revalidate and keeps the persisted version as optimistic guard', () => {
    const w = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('10.00'),
      version: 7,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(w.persistedVersion).toBe(7);
    w.credit(brl('1.00'), 't', 'e', new Date());
    expect(w.version).toBe(8);
    expect(w.persistedVersion).toBe(7);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    createdAt: new Date(),
  };
  test('create validates arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(ValidationError);
    const ok = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('110.00'),
    });
    expect(ok.isBalanced()).toBe(true);
  });

  test('is structurally immutable: no mutators exposed', () => {
    const proto = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter((n) => n !== 'constructor');
    expect(proto).toEqual(['isBalanced']);
  });
});
