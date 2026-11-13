import { ValidationError } from '../domain/errors';
import { Money, MoneyProps } from '../domain/money';
import { FailureCode } from '../domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { canonicalJson, sha256Hex } from '../shared/util';

export type SubmittableKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
}

export interface InboxOrigin {
  consumerName: string;
  messageId: string;
}

export interface WagerResult {
  transactionId: string;
  status: `${WagerTransactionStatus}`;
  failureCode?: `${FailureCode}`;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

const SUBMITTABLE = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const str = (o: Record<string, unknown>, k: string, max = 200): string => {
  const v = o[k];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new ValidationError(`"${k}" must be a non-empty string up to ${max} chars`);
  }
  return v;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (o: Record<string, unknown>, k: string): string => {
  const v = str(o, k, 36);
  if (!UUID_RE.test(v)) throw new ValidationError(`"${k}" must be a UUID`);
  return v.toLowerCase();
};

/** Shared by HTTP and SQS: one parser => one set of rules. OPENING is rejected here. */
export function parseSubmitCommand(
  body: unknown,
  idempotencyKey: string | undefined,
  correlationId: string,
): SubmitWagerCommand {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('body must be an object');
  const o = body as Record<string, unknown>;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 255) {
    throw new ValidationError('Idempotency-Key is required (1-255 chars)', 'MISSING_IDEMPOTENCY_KEY');
  }
  const kind = o.kind;
  if (typeof kind !== 'string' || !SUBMITTABLE.has(kind)) {
    throw new ValidationError('kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK', 'INVALID_KIND');
  }
  const ref = o.referenceExternalTransactionId;
  if (ref !== undefined && ref !== null && (typeof ref !== 'string' || ref.length === 0 || ref.length > 200)) {
    throw new ValidationError('referenceExternalTransactionId must be a non-empty string');
  }
  const money = Money.from(o.money as MoneyProps);
  if (kind !== WagerTransactionKind.Loss && !money.isPositive()) {
    throw new ValidationError('amount must be greater than zero', 'INVALID_MONEY');
  }
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !ref) {
    throw new ValidationError(`${kind} requires referenceExternalTransactionId`, 'REFERENCE_REQUIRED');
  }
  return {
    providerId: str(o, 'providerId'),
    externalTransactionId: str(o, 'externalTransactionId'),
    idempotencyKey,
    playerId: str(o, 'playerId'),
    walletId: uuid(o, 'walletId'),
    roundId: str(o, 'roundId'),
    gameId: str(o, 'gameId'),
    kind: kind as SubmittableKind,
    money,
    referenceExternalTransactionId: typeof ref === 'string' ? ref : undefined,
    correlationId,
  };
}

/**
 * payloadHash = SHA-256 (hex) of the canonical JSON (recursively sorted keys)
 * of the business fields only. Idempotency key, correlation id, message id and
 * any transport metadata are excluded. Money is normalised to scale 2.
 */
export function payloadHashOf(c: SubmitWagerCommand): string {
  return sha256Hex(
    canonicalJson({
      providerId: c.providerId,
      externalTransactionId: c.externalTransactionId,
      playerId: c.playerId,
      walletId: c.walletId,
      roundId: c.roundId,
      gameId: c.gameId,
      kind: c.kind,
      money: c.money.toJSON(),
      referenceExternalTransactionId: c.referenceExternalTransactionId ?? null,
    }),
  );
}
