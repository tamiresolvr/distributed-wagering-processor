import { Migration } from '@mikro-orm/migrations';

/**
 * Schema = the source of truth for invariants:
 *  - uniqueness: (player,currency) wallet, idempotency key, (provider,externalId),
 *    one ledger entry per (wallet, transaction), one PROCESSED reversal per reference,
 *    inbox (consumer, message)
 *  - non-negativity: balance >= 0, ledger balances >= 0, amounts > 0
 *  - ledger arithmetic: balance_after = balance_before +/- amount
 *  - immutability: ledger UPDATE/DELETE/TRUNCATE blocked by triggers; terminal
 *    transactions cannot change state or be deleted
 */
export class Migration20260101000000InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
CREATE TABLE wallets (
  id          uuid PRIMARY KEY,
  player_id   text NOT NULL,
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance     numeric(20,2) NOT NULL CHECK (balance >= 0),
  version     bigint NOT NULL CHECK (version >= 1),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency)
)`);

    this.addSql(`
CREATE TABLE wager_transactions (
  id                               uuid PRIMARY KEY,
  provider_id                      text NOT NULL,
  external_transaction_id          text NOT NULL,
  idempotency_key                  text NOT NULL,
  payload_hash                     text NOT NULL,
  wallet_id                        uuid NOT NULL REFERENCES wallets(id),
  player_id                        text NOT NULL,
  round_id                         text NOT NULL,
  game_id                          text NOT NULL,
  kind                             text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount                           numeric(20,2) NOT NULL CHECK (amount >= 0),
  currency                         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference_external_transaction_id text,
  reference_transaction_id         uuid REFERENCES wager_transactions(id),
  status                           text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code                     text,
  balance_after                    numeric(20,2) CHECK (balance_after IS NULL OR balance_after >= 0),
  attempts                         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at                  timestamptz,
  correlation_id                   text,
  created_at                       timestamptz NOT NULL,
  processed_at                     timestamptz,
  CONSTRAINT uq_tx_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT uq_tx_provider_external UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT ck_tx_failure_code CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CONSTRAINT ck_tx_reference_required CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT ck_tx_terminal_processed_at CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL))
)`);

    // A reference can be reversed (REFUND or ROLLBACK) at most once.
    this.addSql(`
CREATE UNIQUE INDEX uq_tx_single_reversal ON wager_transactions (reference_transaction_id)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);
    this.addSql(`
CREATE INDEX ix_tx_pending_due ON wager_transactions (next_attempt_at)
  WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
CREATE INDEX ix_tx_pending_ref ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX ix_tx_wallet ON wager_transactions (wallet_id)`);

    this.addSql(`
CREATE TABLE wallet_ledger_entries (
  id             uuid PRIMARY KEY,
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  wallet_id      uuid NOT NULL REFERENCES wallets(id),
  transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
  direction      text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount         numeric(20,2) NOT NULL CHECK (amount > 0),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
  balance_after  numeric(20,2) NOT NULL CHECK (balance_after >= 0),
  created_at     timestamptz NOT NULL,
  CONSTRAINT uq_ledger_wallet_tx UNIQUE (wallet_id, transaction_id),
  CONSTRAINT uq_ledger_seq UNIQUE (seq),
  CONSTRAINT ck_ledger_arithmetic CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
    (direction = 'DEBIT'  AND balance_after = balance_before - amount))
)`);
    this.addSql(`CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq)`);

    this.addSql(`
CREATE TABLE inbox_messages (
  consumer_name text NOT NULL,
  message_id    text NOT NULL,
  payload_hash  text NOT NULL,
  received_at   timestamptz NOT NULL,
  processed_at  timestamptz,
  PRIMARY KEY (consumer_name, message_id)
)`);

    this.addSql(`
CREATE TABLE outbox_messages (
  id              uuid PRIMARY KEY,
  aggregate_id    text NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  occurred_at     timestamptz NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  published_at    timestamptz
)`);
    this.addSql(`
CREATE INDEX ix_outbox_pending ON outbox_messages (next_attempt_at)
  WHERE published_at IS NULL`);

    // ---- immutability guards
    this.addSql(`
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden (append-only)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$`);
    this.addSql(`
CREATE TRIGGER trg_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`
CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`
CREATE TRIGGER trg_tx_no_delete BEFORE DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
    this.addSql(`
CREATE FUNCTION forbid_terminal_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$`);
    this.addSql(`
CREATE TRIGGER trg_tx_terminal BEFORE UPDATE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_terminal_update()`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
    this.addSql(`DROP FUNCTION IF EXISTS forbid_terminal_update()`);
    this.addSql(`DROP FUNCTION IF EXISTS forbid_mutation()`);
  }
}
