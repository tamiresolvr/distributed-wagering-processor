import { InvalidTransactionStateError, ValidationError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/**
 * Valid transitions (anything else throws InvalidTransactionStateError):
 *   PENDING            -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE  -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (retry)
 *   PROCESSED | REJECTED | FAILED -> (terminal)
 */
export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Wallet balance observed when the transaction reached its latest state. */
  balanceAfter?: Money;
  attempts: number;
  nextAttemptAt?: Date;
}

export type CreateWagerTransactionProps = Omit<
  WagerTransactionState,
  'status' | 'referenceTransactionId' | 'failureCode' | 'processedAt' | 'balanceAfter' | 'attempts' | 'nextAttemptAt'
>;

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;
  private _balanceAfter?: Money;
  private _attempts: number;
  private _nextAttemptAt?: Date;

  private constructor(s: WagerTransactionState) {
    this.id = s.id;
    this.providerId = s.providerId;
    this.externalTransactionId = s.externalTransactionId;
    this.idempotencyKey = s.idempotencyKey;
    this.payloadHash = s.payloadHash;
    this.walletId = s.walletId;
    this.playerId = s.playerId;
    this.roundId = s.roundId;
    this.gameId = s.gameId;
    this.kind = s.kind;
    this.money = s.money;
    this.referenceExternalTransactionId = s.referenceExternalTransactionId;
    this.createdAt = s.createdAt;
    this._status = s.status;
    this._referenceTransactionId = s.referenceTransactionId;
    this._failureCode = s.failureCode;
    this._processedAt = s.processedAt;
    this._balanceAfter = s.balanceAfter;
    this._attempts = s.attempts;
    this._nextAttemptAt = s.nextAttemptAt;
  }

  /** Born PENDING. OPENING is internal and cannot be created through this factory. */
  static create(p: CreateWagerTransactionProps): WagerTransaction {
    if (p.kind === WagerTransactionKind.Opening) throw new ValidationError('OPENING is internal', 'INVALID_KIND');
    const requires = p.kind === WagerTransactionKind.Refund || p.kind === WagerTransactionKind.Rollback;
    if (requires && !p.referenceExternalTransactionId) {
      throw new ValidationError(`${p.kind} requires referenceExternalTransactionId`, 'REFERENCE_REQUIRED');
    }
    if (p.kind !== WagerTransactionKind.Loss && !p.money.isPositive()) {
      throw new ValidationError('amount must be greater than zero');
    }
    return new WagerTransaction({ ...p, status: WagerTransactionStatus.Pending, attempts: 0 });
  }

  /** Internal wallet-opening transaction, born PROCESSED. */
  static opening(p: { id: string; walletId: string; playerId: string; money: Money; now: Date }): WagerTransaction {
    const key = `opening:${p.walletId}`;
    return new WagerTransaction({
      id: p.id,
      providerId: 'internal',
      externalTransactionId: key,
      idempotencyKey: key,
      payloadHash: key,
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: p.money,
      createdAt: p.now,
      status: WagerTransactionStatus.Processed,
      processedAt: p.now,
      balanceAfter: p.money,
      attempts: 0,
    });
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(s);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.assertOpen('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._balanceAfter = balanceAfter;
    this._nextAttemptAt = undefined;
  }

  /** Counts one more wait for the reference and schedules the next attempt. */
  markPendingReference(nextAttemptAt: Date, balanceObserved: Money): void {
    this.assertOpen('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
    this._balanceAfter = balanceObserved;
  }

  reject(code: FailureCode, at: Date, balanceObserved: Money): void {
    this.assertOpen('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._balanceAfter = balanceObserved;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertOpen('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** BET debits; WIN/REFUND/OPENING credit; ROLLBACK inverts the reference. LOSS has no direction. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new ValidationError('ROLLBACK needs its reference to derive a direction');
        return reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      default:
        throw new ValidationError(`${this.kind} has no ledger direction`);
    }
  }

  private assertOpen(op: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`cannot ${op} on terminal transaction ${this.id} (${this._status})`);
    }
  }
}
