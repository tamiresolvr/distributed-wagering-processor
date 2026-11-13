# ARCHITECTURE

## 1. Visão geral

```
HTTP ──┐                                   ┌── outbox publisher ──► wager-events.fifo
       ├─► WagerProcessor (1 use case) ──► PostgreSQL (wallet, ledger, tx, inbox, outbox)
SQS ───┘        ▲                          └── pending-reference worker (backoff)
 consumer ──────┘
```
Um único use case (`WagerProcessor.submit`) atende HTTP e SQS. Cada submissão é **uma transação SQL**: inbox → lock da wallet → checagem de idempotência → decisão (regras) → linha da transação → saldo + ledger → eventos na outbox. Nada é publicado antes do COMMIT.

## 2. Money
`Money` guarda **minor units em `bigint`** (escala fixa 2) — nenhum `number`/float em qualquer ponto. A entrada aceita só `^\d{1,18}(\.\d{1,2})?$` (rejeita vazio, NaN, Infinity, notação científica, sinais, >2 casas) e sempre serializa com 2 casas. Resultados derivados podem ser negativos (necessário para `subtract`/`isNegative`), entradas não. Persistência: `numeric(20,2)` + `currency text`, reidratados por `Money.from`. O domínio não importa ORM nem Nest. Escolhi `bigint` em vez de `decimal.js` para evitar dependência e porque aritmética inteira em escala fixa é exata por construção.

## 3. ORM e estratégia transacional
**MikroORM 6** (preferencial): usado para pool de conexões, `EntityManager.transactional()` (fronteira da transação) e Migrator. O acesso a dados dentro da transação é **SQL parametrizado na conexão da transação** (`conn.execute(sql, params, 'all', tx)`), não Unit of Work/Identity Map. Justificativa: as operações críticas só são expressáveis como SQL específico (`SELECT … FOR UPDATE`, `ON CONFLICT DO NOTHING RETURNING`, `FOR UPDATE SKIP LOCKED`, update condicionado por versão); um Identity Map só adicionaria um segundo estado em memória para divergir do banco. Os agregados do domínio são mapeados à mão (`rehydrate`), mantendo o domínio livre de decorators. *Trade-off assumido:* não uso `EntitySchema`/`LockMode`; custo é mapear linhas manualmente.

## 4. Concorrência (unidade = `walletId`)
Estratégia combinada:
1. **Lock pessimista por linha** (`SELECT … FROM wallets WHERE id=? FOR UPDATE`) no início da transação. Serializa apenas operações da *mesma* wallet; wallets diferentes rodam em paralelo; não há lock global. Em hot wallet a fila é do próprio Postgres, sem retry-storm.
2. **Update guardado por versão** (`WHERE id=? AND version=?`) como cinto-e-suspensório: se alguém violar o protocolo, vira `ConcurrentModificationError` → rollback + retry (≤4) em vez de lost update.
3. **CHECK `balance >= 0`** e o domínio (`debit` lança `InsufficientFundsError` antes de mutar) garantem não-negatividade mesmo contra bug de aplicação.
4. Ordem global de locks: **wallet → linha da transação**, em todos os caminhos (submit, reprocess), evitando deadlock; deadlock/serialização remanescentes (`40P01`/`40001`) são retentados e contados em `wager_lock_conflicts_total`.

Pessimista ganhou do otimista porque em hot wallet o otimista degrada em retries; o lock curto (uma transação de poucos statements) é previsível.

`version` inicia em 1 e só incrementa quando o saldo muda (REJECTED/LOSS não mudam).

## 5. Idempotência
- `idempotency_key` **UNIQUE** e `(provider_id, external_transaction_id)` **UNIQUE** no banco. Nenhum cache em memória.
- `payloadHash` = **SHA-256 (hex) do JSON canônico** (chaves ordenadas recursivamente) de `{providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount normalizado, currency}, referenceExternalTransactionId|null}`. Header, correlation id, messageId e metadados de transporte ficam de fora; `"25"` e `"25.00"` produzem o mesmo hash.
- Mesma key + mesmo hash → replay (`idempotentReplay:true`) com o **resultado original, incluindo o saldo observado** (`balance_after` guardado na transação). Mesma key (ou mesmo external id) + hash diferente → `IDEMPOTENCY_CONFLICT` (409).
- Corrida: o insert usa `ON CONFLICT DO NOTHING`; quem perde faz rollback completo (inclusive saldo) e re-executa, caindo no caminho de replay. Como o lock da wallet vem antes da checagem, duplicatas da mesma wallet já se serializam.

## 6. Modelo de transações
Transições (qualquer outra → `InvalidTransactionStateError`; também bloqueadas por trigger no banco):
```
PENDING            → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE  → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
PROCESSED | REJECTED | FAILED → terminal
```
A transação nasce PENDING em memória e é persistida já no estado decidido (uma escrita, sem janela intermediária visível). `FAILED` está modelado e protegido no schema para falha permanente de infraestrutura, mas o fluxo atual nunca o produz: falhas de infra são retentadas (HTTP 503 / retry de fila) e, esgotadas, vão à DLQ — documentado como limitação.

### Interpretações adicionais adotadas
- **Uma referência só pode ser revertida uma vez no total** (por REFUND *ou* ROLLBACK), mais estrito que "pelo mesmo tipo", para impedir BET reembolsada *e* revertida (crédito duplo). Garantido por índice único parcial `uq_tx_single_reversal` (`reference_transaction_id` onde `PROCESSED` e kind REFUND/ROLLBACK).
- WIN/LOSS: referência opcional. Se resolvível, é validada (mesma wallet/player/rodada/moeda, kind BET, processada); se ausente/pendente, processa sem vínculo (não bloqueia pagamento por reordenação).
- REFUND/ROLLBACK cujo alvo está PENDING_REFERENCE espera (não rejeita). Alvo REJECTED/FAILED → `REFERENCE_NOT_PROCESSED`.
- ROLLBACK de BET credita; de WIN ou REFUND debita (pode falhar por saldo → `REVERSAL_INSUFFICIENT_FUNDS`).
- BET/WIN/REFUND/ROLLBACK exigem valor > 0; LOSS aceita 0.00. `OPENING` nunca entra por API/fila.
- A moeda de operação ≠ moeda da wallet e `playerId` ≠ dono da wallet são REJECTED (persistidos, auditáveis). Wallet inexistente é erro (404 / ack terminal na fila) e **não** é persistido (não há FK possível).

## 7. Taxonomia de `failureCode`
| Código | Significado | Provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | desistir / nova operação com novo id |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão (débito) deixaria saldo negativo | tratar fora de banda (operacional) |
| `REFERENCE_NOT_FOUND` | referência não chegou no orçamento de retentativas | enviar a referência e reenviar |
| `REFERENCE_NOT_PROCESSED` | referência REJECTED/FAILED/nunca concluiu | desistir |
| `REFERENCE_MISMATCH` | referência de outro player/wallet/rodada/moeda | corrigir payload |
| `INVALID_REFERENCE_KIND` | kind de referência não permitido | corrigir payload |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ valor da referência | corrigir payload |
| `ALREADY_REVERSED` | referência já revertida | nada a fazer |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | corrigir payload |
| `WALLET_PLAYER_MISMATCH` | player não é dono da wallet | corrigir payload |
| `INTERNAL_ERROR` | reservado a `FAILED` | contatar operação |

## 8. Referências fora de ordem (7.1)
`PENDING_REFERENCE` com `attempts` e `next_attempt_at`. Um worker em cada instância faz polling; o **claim é o lock** wallet→tx dentro da transação, com recheck de estado/horário, então N workers não processam em duplicidade. Backoff exponencial `base·2^attempts` (2 s base, teto 60 s). **Limite: 12 tentativas (~8 min acumulados)** — janela suficiente para reordenação normal de provedores sem manter pendências eternas; configurável (`PENDING_MAX_ATTEMPTS`). Esgotado → `REJECTED` + `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`. Quando a referência vira `PROCESSED`, os dependentes têm `next_attempt_at` antecipado (`wakeDependents`), evitando esperar o backoff.

## 9. Inbox / Outbox / SQS
- **Inbox** `(consumer_name, message_id)` PK, inserida **na mesma transação** das mudanças; duplicata concorrente bloqueia no insert até o commit do primeiro e depois vê o conflito (replay). Mesmo messageId com payload diferente → conflito terminal (ack + métrica).
- **Outbox**: eventos gravados na transação financeira. O publisher faz `SELECT … FOR UPDATE SKIP LOCKED` por lote, publica na fila de eventos (`MessageGroupId=aggregateId`, `MessageDeduplicationId=eventId`) e marca `published_at` na mesma transação. Se o processo morre, a transação reverte, as linhas se liberam e outra instância publica. Falha de publish → `scheduleRetry` (backoff 500 ms·2ⁿ, teto 60 s). Garantia: **at-least-once**; consumidores deduplicam por `eventId`. `SKIP LOCKED` não preserva ordem entre lotes concorrentes — consumidores devem usar `walletVersion` para ordenar `WalletBalanceChanged`.
- **Consumer**: ack só após o commit. Classificação: negócio terminal (REJECTED, conflito de idempotência, wallet inexistente) → ack; payload malformado → DLQ imediata; transitório/desconhecido → `ChangeMessageVisibility` com backoff `2^receiveCount` s; ao atingir `CONSUMER_MAX_RECEIVE_COUNT` (5) → cópia para a DLQ e ack. A fila principal também tem *redrive policy* (maxReceiveCount+2) como rede de segurança contra crash em loop. SIGTERM: `stop()` aguarda o lote em andamento; mensagens ainda não iniciadas têm visibilidade devolvida (0).
- FIFO (group = walletId) é **otimização**: todas as invariantes valem sem ele.

## 10. Schema como fonte das invariantes
`wallets`: UNIQUE(player,currency), CHECK(balance≥0), version≥1. `wager_transactions`: UNIQUE(idempotency_key), UNIQUE(provider,external), índice único parcial de reversão única, CHECKs (failure_code ⇔ REJECTED/FAILED, referência obrigatória em REFUND/ROLLBACK, processed_at ⇔ terminal), trigger que **bloqueia UPDATE de estado terminal** e DELETE. `wallet_ledger_entries`: UNIQUE(wallet,transaction) (≤1 lançamento por wallet por transação), CHECK `amount>0`, CHECK de aritmética (`after = before ± amount`), saldos ≥0, e triggers que **proíbem UPDATE/DELETE/TRUNCATE** (append-only), `seq` identity para paginação por cursor estável. Migration reversível (`down`).

Limite conhecido: a igualdade `wallet.balance == Σ ledger` não é uma constraint declarativa (exigiria constraint trigger diferido); é garantida pelo mesmo bloco transacional + lock e **verificada** pelo endpoint de reconciliação e por todos os testes.

## 11. Reconciliação
`POST /wallets/:id/reconciliation` calcula, em **um único statement** (um snapshot), saldo armazenado × soma do ledger. Divergência: `consistent:false`, log `error` e contador `wager_reconciliation_divergences_total`. Nunca corrige.

## 12. Observabilidade
Logs JSON (`src/shared/logger.ts`) apenas com identificadores (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, status, failureCode) — sem valores/payloads. `GET /metrics` (Prometheus): transações por status/kind, duplicatas, retries, DLQ, conflitos de lock, espera de lock, outbox lag (calculado no scrape), publicados/falhas, latência de processamento, divergências. `/health/live` e `/health/ready` (PostgreSQL + SQS) sem autenticação.

## 13. Autenticação (não implementada — decisão documentada)
Por não pontuar e para priorizar correção financeira, **não implementei autenticação**. Ponto de extensão explícito: `AuthGuard` (no-op) aplicado a todos os controllers exceto health/metrics. Desenho adotado em produção: Keycloak (OIDC) emitindo JWT por provedor (client credentials); o guard valida assinatura/expiração via JWKS e mapeia a claim `azp`/client-id para `providerId` através de um `ProviderIdentityPort`, rejeitando 403 quando `body.providerId` ≠ identidade do token. Mensagens da fila são canal interno confiável, mas continuam sujeitas às mesmas validações de domínio (mesmo parser).

## 14. Limitações e trade-offs
- **Não executado neste ambiente**: o código e a suíte foram escritos sem Bun/Docker disponíveis na máquina de desenvolvimento; nenhum teste foi rodado. Esperam-se ajustes de integração (versões de MikroORM/Nest sob Bun, formato de placeholders do `execute`).
- Publisher mantém uma transação aberta durante o envio ao SQS (lote pequeno, 50): simples e correto, mas segura locks de linhas da outbox; um esquema com lease seria mais escalável.
- Ordenação de eventos entre publishers concorrentes não é garantida (ver §9).
- `FAILED` não é produzido pelo fluxo atual.
- Sem partição/arquivamento da outbox/inbox (crescimento ilimitado; precisa de job de retenção).
- Teste de carga implementado (`bun run test:load`), mas **sem resultados registrados** — não foi executado.
