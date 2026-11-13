import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { JsonLogger, log } from './shared/logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.enableShutdownHooks(); // SIGTERM/SIGINT: consumer + workers drain before the DB pool closes
  const { port } = loadConfig();
  await app.listen(port, '0.0.0.0');
  log.info('wagering processor listening', { port });
}

bootstrap().catch((e) => {
  log.error('bootstrap failed', { error: (e as Error).message });
  process.exit(1);
});
