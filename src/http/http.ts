import { CanActivate, Controller, Get, Header, HttpException, Inject, Injectable, UseGuards, ExecutionContext, Catch, ArgumentsHost, ExceptionFilter, Post, Body, Param, Query, Headers, Res, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { WalletService } from '../application/wallet.service';
import { WagerProcessor } from '../application/wager-processor';
import { parseSubmitCommand } from '../application/commands';
import { Database, isTransientDbError } from '../infrastructure/db/database';
import { outboxRepo } from '../infrastructure/db/repositories';
import { SqsGateway } from '../infrastructure/sqs/sqs.gateway';
import {
  DomainError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../domain/errors';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { log } from '../shared/logger';
import { metrics, registry } from '../shared/metrics';
import { uuidv7 } from '../shared/util';

/**
 * Extension point for authentication (see ARCHITECTURE.md §Auth): intentionally a no-op.
 * Production: validate an OIDC JWT issued by an external IdP (e.g. Keycloak) and
 * map the token's client/provider claim to `providerId` through a ProviderIdentityPort.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    return true;
  }
}

/**
 * Consistent error contract on every endpoint:
 *   400 invalid payload          (retryable=false)
 *   404 not found                (retryable=false)
 *   409 conflict (idempotency / duplicate wallet) (retryable=false)
 *   422 business rejection       (returned by POST /wagering/transactions with the stored result)
 *   202 accepted, processing pending (PENDING_REFERENCE)
 *   503 transient infrastructure failure + Retry-After (retryable=true)
 *   500 unexpected               (retryable=false)
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (status: number, code: string, message: string, retryable: boolean) => {
      if (retryable) res.setHeader('Retry-After', '1');
      res.status(status).json({ error: { code, message, retryable } });
    };
    if (e instanceof IdempotencyConflictError) return send(409, e.code, e.message, false);
    if (e instanceof WalletAlreadyExistsError) return send(409, e.code, e.message, false);
    if (e instanceof WalletNotFoundError || e instanceof TransactionNotFoundError) return send(404, e.code, e.message, false);
    if (e instanceof ValidationError) return send(400, e.code, e.message, false);
    if (e instanceof DomainError) return send(422, e.code, e.message, false);
    if (e instanceof HttpException) {
      const status = e.getStatus();
      return send(status, status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', e.message, false);
    }
    if (isTransientDbError(e) || (e as Error)?.name === 'ConcurrentModificationError' || (e as Error)?.name === 'ConcurrentDuplicateError') {
      log.warn('transient infrastructure failure', { error: (e as Error)?.message });
      return send(503, 'SERVICE_UNAVAILABLE', 'transient failure, retry with the same Idempotency-Key', true);
    }
    log.error('unhandled error', { error: (e as Error)?.message });
    return send(500, 'INTERNAL_ERROR', 'unexpected error', false);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireUuid = (id: string): string => {
  if (!UUID.test(id)) throw new WalletNotFoundError(id);
  return id;
};

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  @Post()
  async create(@Body() body: any, @Res({ passthrough: true }) res: Response) {
    const created = await this.wallets.create(body?.playerId, body?.initialBalance);
    res.status(HttpStatus.CREATED);
    return created;
  }

  @Get(':walletId')
  get(@Param('walletId') id: string) {
    return this.wallets.get(requireUuid(id));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.wallets.ledger(requireUuid(id), cursor, limit);
  }

  @Post(':walletId/reconciliation')
  reconcile(@Param('walletId') id: string) {
    return this.wallets.reconcile(requireUuid(id));
  }
}

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(WagerProcessor) private readonly processor: WagerProcessor,
    @Inject(WalletService) private readonly wallets: WalletService,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: any,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationHeader: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cmd = parseSubmitCommand(body, idempotencyKey, correlationHeader || uuidv7());
    const result = await this.processor.submit(cmd);
    switch (result.status) {
      case WagerTransactionStatus.Processed:
        res.status(HttpStatus.OK);
        break;
      case WagerTransactionStatus.PendingReference:
      case WagerTransactionStatus.Pending:
        res.status(HttpStatus.ACCEPTED);
        break;
      default:
        res.status(HttpStatus.UNPROCESSABLE_ENTITY); // REJECTED / FAILED: stored, auditable, not retryable as-is
    }
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') id: string) {
    if (!UUID.test(id)) throw new TransactionNotFoundError();
    return this.wallets.transactionById(id);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byProvider(@Param('providerId') providerId: string, @Param('externalTransactionId') ext: string) {
    return this.wallets.transactionByProvider(providerId, ext);
  }
}

/** Health endpoints and metrics are deliberately unauthenticated. */
@Controller()
export class HealthController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
  ) {
    // Lag is computed at scrape time from the oldest unpublished outbox row.
    (metrics.outboxLag as any).collect = async function (this: { set(v: number): void }) {
      this.set(await outboxRepo.lagSeconds(db).catch(() => 0));
    };
  }

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const check = async (fn: () => Promise<void>) => {
      try {
        await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
        return 'up';
      } catch {
        return 'down';
      }
    };
    const [postgres, sqs] = await Promise.all([check(() => this.db.ping()), check(() => this.sqs.ping())]);
    const ok = postgres === 'up' && sqs === 'up';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async metrics() {
    return registry.metrics();
  }
}
