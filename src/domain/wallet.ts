import { CurrencyMismatchError, InsufficientFundsError, ValidationError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate root. Every balance change returns the ledger entry that explains
 * it, so balance and ledger cannot diverge in memory. Concurrency control is
 * enforced by the persistence layer (row lock + version guard).
 */
export class Wallet {
  /** Version as loaded from the database; used as the optimistic guard on save. */
  private _persistedVersion: number;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
    persistedVersion: number,
  ) {
    this._persistedVersion = persistedVersion;
  }

  /** Creates a wallet at version 1; an initial balance > 0 yields the OPENING credit entry. */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    openingEntryId: string;
    now: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const { initialBalance: initial, now } = props;
    if (initial.isNegative()) throw new ValidationError('initial balance cannot be negative');
    const wallet = new Wallet(props.id, props.playerId, initial.currency, initial, 1, now, now, 0);
    const openingEntry = initial.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: initial,
          balanceBefore: Money.zero(initial.currency),
          balanceAfter: initial,
          createdAt: now,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — no rule revalidation. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt, s.version);
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }
  get persistedVersion(): number {
    return this._persistedVersion;
  }

  debit(money: Money, transactionId: string, entryId: string, now: Date): WalletLedgerEntry {
    return this.move(LedgerDirection.Debit, money, transactionId, entryId, now);
  }

  credit(money: Money, transactionId: string, entryId: string, now: Date): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, money, transactionId, entryId, now);
  }

  private move(
    direction: LedgerDirection,
    money: Money,
    transactionId: string,
    entryId: string,
    now: Date,
  ): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new ValidationError('amount must be positive');
    const before = this._balance;
    const after = direction === LedgerDirection.Debit ? before.subtract(money) : before.add(money);
    if (after.isNegative()) throw new InsufficientFundsError();
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: now,
    });
    // Mutate only after every check passed.
    this._balance = after;
    this._version += 1;
    this._updatedAt = now;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
