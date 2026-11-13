import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PendingReferenceWorker } from './application/pending-reference.worker';
import { WagerProcessor } from './application/wager-processor';
import { WalletService } from './application/wallet.service';
import { CONFIG, loadConfig, type AppConfig } from './config';
import { ErrorFilter, HealthController, WageringController, WalletsController, AuthGuard } from './http/http';
import { Database, ORM, createOrm } from './infrastructure/db/database';
import { OutboxPublisher } from './infrastructure/sqs/outbox.publisher';
import { SqsGateway } from './infrastructure/sqs/sqs.gateway';
import { WagerConsumer } from './infrastructure/sqs/wager.consumer';

@Module({
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    { provide: ORM, useFactory: (cfg: AppConfig) => createOrm(cfg), inject: [CONFIG] },
    { provide: APP_FILTER, useClass: ErrorFilter },
    Database,
    SqsGateway,
    AuthGuard,
    WagerProcessor,
    WalletService,
    PendingReferenceWorker,
    OutboxPublisher,
    WagerConsumer,
  ],
})
export class AppModule {}
