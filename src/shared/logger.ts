import type { LoggerService } from '@nestjs/common';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * Structured JSON logger. Callers pass identifiers only (correlationId,
 * messageId, transactionId, walletId, providerId) — never payloads/amounts.
 */
export function logEvent(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const min = ORDER[(process.env.LOG_LEVEL as Level | 'silent') ?? 'info'] ?? ORDER.info;
  if (ORDER[level] < min) return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => logEvent('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => logEvent('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => logEvent('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => logEvent('error', m, f),
};

/** Routes NestJS internal logs through the same JSON format. */
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string) {
    log.info(String(message), { context });
  }
  error(message: unknown, trace?: string, context?: string) {
    log.error(String(message), { context, trace });
  }
  warn(message: unknown, context?: string) {
    log.warn(String(message), { context });
  }
  debug(message: unknown, context?: string) {
    log.debug(String(message), { context });
  }
  verbose(message: unknown, context?: string) {
    log.debug(String(message), { context });
  }
}
