# Distributed Wagering Processor

Serviço financeiro distribuído (NestJS + Bun + PostgreSQL + SQS) que processa BET / WIN / LOSS / REFUND / ROLLBACK com correção monetária, idempotência persistente, outbox transacional e múltiplas instâncias.

Decisões, trade-offs e limitações: veja [ARCHITECTURE.md](./ARCHITECTURE.md).

## Requisitos
- Bun 1.x, Docker + Docker Compose

## Subir tudo (3 instâncias + PostgreSQL + LocalStack)
```bash
docker compose up --build
# app1 :3001  app2 :3002  app3 :3003  (mesmo banco, mesmas filas)
```
O job `migrate` aplica as migrations uma única vez antes das instâncias subirem. As filas (`wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`) são criadas de forma idempotente pela aplicação.

## Desenvolvimento local
```bash
bun install
docker compose up -d postgres localstack
bun run migrate:up      # bun run migrate:down reverte
bun run start           # lê as variáveis de .env.example
```

## Testes
```bash
bun run test:unit          # sem infraestrutura
docker compose up -d postgres localstack
bun run test:integration   # PostgreSQL + LocalStack reais, concorrência, 3 instâncias, 3 processos, crash/restart
bun run test:all
bun run test:load          # TARGETS, WALLETS, REQUESTS, CONCURRENCY, HOT_RATIO (instâncias já em execução)
```
Os testes de integração usam wallets novas (UUIDs aleatórios) e não truncam tabelas (o ledger é append-only por trigger), então podem rodar repetidamente sobre o mesmo banco. `TEST_MIGRATION_ROUNDTRIP=true` habilita o teste destrutivo `down`→`up` (use somente em banco descartável).

## API (resumo)
| Método | Rota | Observação |
|---|---|---|
| POST | `/wallets` | 201 / 409 (duplicada) |
| GET | `/wallets/:id`, `/wallets/:id/ledger?cursor&limit` | cursor opaco, estável |
| POST | `/wallets/:id/reconciliation` | não corrige, só reporta |
| POST | `/wagering/transactions` | header `Idempotency-Key` obrigatório |
| GET | `/wagering/transactions/:id`, `/providers/:p/wagering/transactions/:ext` | |
| GET | `/health/live`, `/health/ready`, `/metrics` | sem autenticação |

### Status HTTP (consistente em todos os endpoints)
| Situação | HTTP | Corpo |
|---|---|---|
| PROCESSED (ou replay) | 200 | `{transactionId,status,balance,idempotentReplay}` |
| Aceita, pendente de referência | 202 | `status: PENDING_REFERENCE` |
| Rejeição de negócio (persistida) | 422 | `status: REJECTED`, `failureCode` |
| Payload inválido | 400 | `{error:{code,message,retryable:false}}` |
| Conflito de idempotência / wallet duplicada | 409 | `retryable:false` |
| Não encontrado | 404 | |
| Falha transitória de infraestrutura | 503 + `Retry-After` | `retryable:true` — reenviar com a mesma key |

Exemplo:
```bash
curl -X POST localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
curl -X POST localhost:3001/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"...","walletId":"...","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

## Estrutura
```
src/domain          Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos (sem ORM/Nest)
src/application     WagerProcessor (use case único), WalletService, worker de PENDING_REFERENCE
src/infrastructure  MikroORM + SQL, migrations, SQS (gateway, consumer, outbox publisher)
src/http            controllers, filtro de erros, AuthGuard (no-op), health/metrics
test/unit | integration | load
```
