import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { migrate } from '../../src/migrate';
import { parseSubmitCommand } from '../../src/application/commands';
import { WagerProcessor } from '../../src/application/wager-processor';
import { WalletService } from '../../src/application/wallet.service';
import { Database } from '../../src/infrastructure/db/database';
import { uuidv7 } from '../../src/shared/util';

let migrated = false;
export async function ensureMigrated() {
  if (migrated) return;
  await migrate('up');
  migrated = true;
}

/** Boots one application instance (own connection pool = own "process" from the DB's viewpoint). */
export async function bootApp(env: Record<string, string> = {}): Promise<INestApplicationContext> {
  await ensureMigrated();
  Object.assign(process.env, {
    CONSUMER_ENABLED: 'false',
    PUBLISHER_ENABLED: 'false',
    REPROCESSOR_ENABLED: 'false',
    DB_POOL_MAX: '10',
    ...env,
  });
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  await app.init();
  return app;
}

export const svc = (app: INestApplicationContext) => ({
  processor: app.get(WagerProcessor),
  wallets: app.get(WalletService),
  db: app.get(Database),
});

export const brl = (amount: string) => ({ amount, currency: 'BRL' });

export async function newWallet(app: INestApplicationContext, balance = '100.00') {
  return svc(app).wallets.create(uuidv7(), brl(balance));
}

export interface OpInput {
  walletId: string;
  playerId: string;
  kind?: string;
  amount?: string;
  ext?: string;
  ref?: string;
  roundId?: string;
  provider?: string;
  key?: string;
}

export function command(i: OpInput) {
  const provider = i.provider ?? 'provider-a';
  const ext = i.ext ?? `tx-${uuidv7()}`;
  return parseSubmitCommand(
    {
      providerId: provider,
      externalTransactionId: ext,
      playerId: i.playerId,
      walletId: i.walletId,
      roundId: i.roundId ?? 'round-1',
      gameId: 'fortune-chimp',
      kind: i.kind ?? 'BET',
      money: brl(i.amount ?? '10.00'),
      referenceExternalTransactionId: i.ref,
    },
    i.key ?? `${provider}:${ext}`,
    uuidv7(),
  );
}

/** The invariant that closes every test: wallet.balance == balance rebuilt from the ledger. */
export async function expectConsistent(app: INestApplicationContext, walletId: string) {
  const r = await svc(app).wallets.reconcile(walletId);
  if (!r.consistent) throw new Error(`wallet ${walletId} inconsistent: ${JSON.stringify(r)}`);
  return r;
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 20_000, step = 200): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, step));
  }
}
