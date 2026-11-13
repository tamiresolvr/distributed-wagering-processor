import { FailureCode } from './failure-code';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { MoneyProps } from './money';
import { Wallet } from './wallet';
import { WagerTransaction } from './wager-transaction';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON() {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

const base = (aggregateId: string, ctx: EventContext) => ({
  eventId: ctx.eventId,
  aggregateId,
  correlationId: ctx.correlationId,
  causationId: ctx.causationId,
  occurredAt: ctx.occurredAt,
});

interface TxData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  money: MoneyProps;
}

const txData = (t: WagerTransaction): TxData => ({
  transactionId: t.id,
  walletId: t.walletId,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  kind: t.kind,
  money: t.money.toJSON(),
});

export interface WagerTransactionProcessedData extends TxData {
  balanceAfter?: MoneyProps;
}
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static from(t: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...base(t.walletId, ctx),
      data: { ...txData(t), balanceAfter: t.balanceAfter?.toJSON() },
    });
  }
}

export interface WagerTransactionRejectedData extends TxData {
  failureCode: FailureCode;
}
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static from(t: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...base(t.walletId, ctx),
      data: { ...txData(t), failureCode: t.failureCode as FailureCode },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TxData {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static from(t: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...base(t.walletId, ctx),
      data: {
        ...txData(t),
        referenceExternalTransactionId: t.referenceExternalTransactionId ?? '',
        attempts: t.attempts,
        nextAttemptAt: (t.nextAttemptAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...base(wallet.id, ctx),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
