import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { InvalidTransactionStateError, ValidationError } from '../../src/domain/errors';
import {
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/wager-transaction';
import { OutboxMessage } from '../../src/domain/messaging';
import { WalletBalanceChanged } from '../../src/domain/events';
import { Wallet } from '../../src/domain/wallet';
import { parseSubmitCommand, payloadHashOf } from '../../src/application/commands';
import { canonicalJson } from '../../src/shared/util';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const mk = (kind: K, extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) =>
  WagerTransaction.create({
    id: 'tx',
    providerId: 'p',
    externalTransactionId: 'x1',
    idempotencyKey: 'p:x1',
    payloadHash: 'h',
    walletId: 'w',
    playerId: 'pl',
    roundId: 'r',
    gameId: 'g',
    kind,
    money: brl('10.00'),
    createdAt: new Date(),
    ...extra,
  });

describe('WagerTransaction', () => {
  test('is born PENDING', () => {
    expect(mk(K.Bet).status).toBe(S.Pending);
  });

  test('OPENING cannot be created from outside', () => {
    expect(() => mk(K.Opening)).toThrow(ValidationError);
  });

  test('REFUND and ROLLBACK require a reference', () => {
    expect(() => mk(K.Refund)).toThrow(ValidationError);
    expect(() => mk(K.Rollback)).toThrow(ValidationError);
    expect(mk(K.Refund, { referenceExternalTransactionId: 'b1' }).requiresReference()).toBe(true);
    expect(mk(K.Bet).requiresReference()).toBe(false);
  });

  test('LOSS does not affect balance, others do', () => {
    expect(mk(K.Loss).affectsBalance()).toBe(false);
    expect(mk(K.Bet).affectsBalance()).toBe(true);
    expect(mk(K.Win).affectsBalance()).toBe(true);
  });

  test('ledger direction per kind (ROLLBACK inverts its reference)', () => {
    const ref = (kind: K) => mk(kind, { referenceExternalTransactionId: 'ref-1' });
    const rb = mk(K.Rollback, { referenceExternalTransactionId: 'r' });
    expect(mk(K.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(mk(K.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(mk(K.Refund, { referenceExternalTransactionId: 'r' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(ref(K.Bet))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(ref(K.Win))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(ref(K.Refund))).toBe(LedgerDirection.Debit);
    expect(() => mk(K.Loss).ledgerDirectionFor()).toThrow();
  });

  test('valid transitions: PENDING -> PENDING_REFERENCE -> PROCESSED', () => {
    const t = mk(K.Refund, { referenceExternalTransactionId: 'b' });
    t.markPendingReference(new Date(), brl('1.00'));
    t.markPendingReference(new Date(), brl('1.00'));
    expect(t.attempts).toBe(2);
    expect(t.status).toBe(S.PendingReference);
    t.markProcessed('ref', new Date(), brl('11.00'));
    expect(t.status).toBe(S.Processed);
    expect(t.referenceTransactionId).toBe('ref');
    expect(t.isTerminal()).toBe(true);
  });

  test.each([
    ['markProcessed', (t: WagerTransaction) => t.markProcessed(undefined, new Date(), brl('1.00'))],
    ['markPendingReference', (t: WagerTransaction) => t.markPendingReference(new Date(), brl('1.00'))],
    ['reject', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, new Date(), brl('1.00'))],
    ['fail', (t: WagerTransaction) => t.fail(FailureCode.InternalError, new Date())],
  ])('terminal states are final (%s)', (_n, op) => {
    for (const terminate of [
      (t: WagerTransaction) => t.markProcessed(undefined, new Date(), brl('1.00')),
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, new Date(), brl('1.00')),
      (t: WagerTransaction) => t.fail(FailureCode.InternalError, new Date()),
    ]) {
      const t = mk(K.Bet);
      terminate(t);
      expect(() => op(t)).toThrow(InvalidTransactionStateError);
    }
  });

  test('reject carries a failure code', () => {
    const t = mk(K.Bet);
    t.reject(FailureCode.InsufficientFunds, new Date(), brl('5.00'));
    expect(t.status).toBe(S.Rejected);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('rehydrate restores terminal state without revalidation', () => {
    const t = WagerTransaction.rehydrate({
      id: 'x', providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'h', walletId: 'w',
      playerId: 'pl', roundId: 'r', gameId: 'g', kind: K.Refund, money: brl('1.00'), createdAt: new Date(),
      status: S.Rejected, failureCode: FailureCode.ReferenceNotFound, attempts: 3,
    });
    expect(t.isTerminal()).toBe(true);
    expect(t.requiresReference()).toBe(true);
  });
});

describe('idempotency payload hash', () => {
  const body = {
    providerId: 'provider-a', externalTransactionId: 'tx-1', playerId: 'p',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37', roundId: 'r', gameId: 'g', kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  const cmd = (b: unknown, key = 'provider-a:tx-1', corr = 'c1') => parseSubmitCommand(b, key, corr);

  test('is stable across key order, header value, correlation id and amount formatting', () => {
    const reordered = { money: { currency: 'BRL', amount: '25' }, kind: 'BET', gameId: 'g', roundId: 'r',
      walletId: body.walletId, playerId: 'p', externalTransactionId: 'tx-1', providerId: 'provider-a' };
    expect(payloadHashOf(cmd(body))).toBe(payloadHashOf(cmd(reordered, 'other-key', 'c2')));
  });

  test('changes when any business field changes', () => {
    const h = payloadHashOf(cmd(body));
    expect(payloadHashOf(cmd({ ...body, money: { amount: '25.01', currency: 'BRL' } }))).not.toBe(h);
    expect(payloadHashOf(cmd({ ...body, roundId: 'r2' }))).not.toBe(h);
    expect(payloadHashOf(cmd({ ...body, kind: 'WIN' }))).not.toBe(h);
  });

  test('canonical json sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  test('rejects OPENING, missing key, missing reference, bad wallet id', () => {
    expect(() => cmd({ ...body, kind: 'OPENING' })).toThrow(ValidationError);
    expect(() => parseSubmitCommand(body, undefined, 'c')).toThrow(ValidationError);
    expect(() => cmd({ ...body, kind: 'REFUND' })).toThrow(ValidationError);
    expect(() => cmd({ ...body, walletId: 'nope' })).toThrow(ValidationError);
    expect(() => cmd({ ...body, money: { amount: '0.00', currency: 'BRL' } })).toThrow(ValidationError);
  });
});

describe('Outbox / events', () => {
  test('backoff grows exponentially and is capped', () => {
    const wallet = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: brl('1.00'), version: 1, createdAt: new Date(), updatedAt: new Date() });
    const credited = wallet.credit(brl('1.00'), 't', 'e', new Date());
    const ev = WalletBalanceChanged.from(wallet, credited, { eventId: 'ev', correlationId: 'c', occurredAt: new Date() });
    const m = OutboxMessage.enqueue(ev);
    expect(m.isDue(new Date())).toBe(true);
    const now = new Date('2026-01-01T00:00:00Z');
    m.scheduleRetry(now);
    const d1 = m.nextAttemptAt!.getTime() - now.getTime();
    m.scheduleRetry(now);
    const d2 = m.nextAttemptAt!.getTime() - now.getTime();
    expect(d2).toBe(d1 * 2);
    for (let i = 0; i < 30; i++) m.scheduleRetry(now);
    expect(m.nextAttemptAt!.getTime() - now.getTime()).toBe(60_000);
    expect(m.isDue(now)).toBe(false);
    m.markPublished(now);
    expect(m.isPending()).toBe(false);
  });

  test('event payloads are plain JSON with decimal strings', () => {
    const wallet = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: brl('10.00'), version: 1, createdAt: new Date(), updatedAt: new Date() });
    const entry = wallet.debit(brl('2.50'), 't', 'e', new Date());
    const json = JSON.parse(JSON.stringify(WalletBalanceChanged.from(wallet, entry, { eventId: 'ev', correlationId: 'c', occurredAt: new Date() })));
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.data.balanceAfter).toEqual({ amount: '7.50', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
  });
});
