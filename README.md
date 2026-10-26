# Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`,
`ROLLBACK`) de múltiplos provedores de jogos, mantendo saldo materializado e ledger auditável
consistentes sob duplicidade, entrega fora de ordem, concorrência entre instâncias e falhas de
processo.

O enunciado original do desafio está em [`docs/CHALLENGE.md`](docs/CHALLENGE.md). As decisões de
desenho, garantias e limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Capacidades

- `Money` imutável com aritmética decimal exata (inteiro de centavos em `bigint`, `NUMERIC(20,2)` no
  banco), serializado sempre como string com escala 2.
- Wallet com saldo nunca negativo, versão incrementada apenas quando o saldo muda e ledger
  append-only com um lançamento por transação.
- Idempotência persistente pelo header `Idempotency-Key`, com hash SHA-256 de JSON canônico do
  payload de negócio, replay com o resultado original e conflito para payload divergente.
- Lock pessimista por `walletId` (`SELECT ... FOR UPDATE`), correto com várias instâncias.
- Invariantes também no schema: constraints, índices únicos parciais e triggers (ledger imutável,
  cadeia de saldos, consistência wallet x ledger no commit, estados terminais imutáveis).
- Consumidor SQS FIFO com inbox persistente, ack após commit, retry com backoff, DLQ e shutdown
  controlado.
- Transactional outbox com publishers concorrentes, lease com recuperação após queda e
  deduplicação por `eventId`.
- Worker de `PENDING_REFERENCE` com backoff exponencial para `REFUND`/`ROLLBACK` fora de ordem.
- Reconciliação saldo x ledger, logs JSON com contexto de correlação, métricas Prometheus e health
  checks separados.

## Stack

| Item                                   | Versão                                                        |
| -------------------------------------- | ------------------------------------------------------------- |
| Runtime, package manager e test runner | Bun 1.4.4                                                     |
| Linguagem                              | TypeScript 5.9 (`strict`, `noUncheckedIndexedAccess`)         |
| Framework                              | NestJS 12 (Express 5)                                         |
| Banco                                  | PostgreSQL 17                                                 |
| ORM e migrations                       | MikroORM 7 (`@mikro-orm/postgresql`, `@mikro-orm/migrations`) |
| Mensageria                             | AWS SQS FIFO via LocalStack 4.4 (`@aws-sdk/client-sqs`)       |
| Validação                              | zod 4                                                         |
| Observabilidade                        | pino (logs JSON), prom-client (métricas)                      |
| Orquestração local                     | Docker Compose                                                |

## Pré-requisitos

- Bun 1.x (`npm install -g bun` ou o instalador oficial de bun.sh).
- Docker com Docker Compose v2.
- Portas livres no host: `55432` (PostgreSQL), `4566` (LocalStack) e `8080` (API). Podem ser
  alteradas com `POSTGRES_HOST_PORT`, `LOCALSTACK_HOST_PORT` e `API_HOST_PORT`.

## Configuração

```bash
cp .env.example .env
```

O Bun carrega o `.env` automaticamente. A configuração é validada no arranque e o processo falha
listando todas as variáveis inválidas. As principais:

| Variável                                                             | Padrão                                                       | Descrição                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `DATABASE_URL`                                                       | obrigatória                                                  | URL do PostgreSQL                                                  |
| `TEST_DATABASE_URL`                                                  | `postgres://wagering:wagering@localhost:55432/wagering_test` | banco usado pelos testes                                           |
| `DATABASE_POOL_MAX`                                                  | `20`                                                         | conexões por instância                                             |
| `DATABASE_LOCK_TIMEOUT_MS`                                           | `5000`                                                       | espera máxima por lock de linha antes de erro transitório          |
| `HTTP_PORT`                                                          | `8080`                                                       | porta HTTP                                                         |
| `INSTANCE_ID`                                                        | `hostname-pid`                                               | identificador da instância nos logs e no dono das leases           |
| `SUPPORTED_CURRENCIES`                                               | `BRL`                                                        | moedas aceitas na criação de wallets (lista separada por vírgulas) |
| `AWS_ENDPOINT_URL`                                                   | -                                                            | endpoint do LocalStack (`http://localhost:4566`)                   |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`                        | -                                                            | `test`/`test` no LocalStack (não são segredos)                     |
| `SQS_WAGER_QUEUE_NAME`                                               | `wager-transactions.fifo`                                    | fila de entrada                                                    |
| `SQS_WAGER_DLQ_NAME`                                                 | `wager-transactions-dlq.fifo`                                | DLQ                                                                |
| `SQS_EVENTS_QUEUE_NAME`                                              | `wagering-events.fifo`                                       | destino dos eventos da outbox                                      |
| `SQS_CONSUMER_ENABLED`                                               | `true`                                                       | liga o consumidor nesta instância                                  |
| `SQS_MAX_ATTEMPTS`                                                   | `5`                                                          | recebimentos antes da DLQ para falhas transitórias                 |
| `SQS_RETRY_BASE_DELAY_SECONDS` / `SQS_RETRY_MAX_DELAY_SECONDS`       | `2` / `300`                                                  | backoff via visibility timeout                                     |
| `OUTBOX_PUBLISHER_ENABLED`                                           | `true`                                                       | liga o publisher da outbox                                         |
| `OUTBOX_LEASE_MS`                                                    | `30000`                                                      | lease de um lote reivindicado                                      |
| `PENDING_REFERENCE_WORKER_ENABLED`                                   | `true`                                                       | liga o worker de referências pendentes                             |
| `PENDING_REFERENCE_MAX_ATTEMPTS`                                     | `8`                                                          | tentativas antes de `REFERENCE_NOT_FOUND`                          |
| `PENDING_REFERENCE_BASE_DELAY_MS` / `PENDING_REFERENCE_MAX_DELAY_MS` | `1000` / `60000`                                             | backoff exponencial                                                |

A lista completa, com os valores padrão, está em [`src/config/app-config.ts`](src/config/app-config.ts).

## Instalação e execução

### Stack completa em Docker Compose

```bash
docker compose up -d --build --wait
```

Sobe `postgres`, `localstack`, executa o serviço `setup` (migrations e criação das filas, idempotente)
e inicia `api` (porta 8080, sem consumidor SQS) e `worker` com duas réplicas (consumidor SQS, outbox
e worker de pendências). As três instâncias compartilham o mesmo banco e as mesmas filas.

```bash
curl -s localhost:8080/health/ready
docker compose logs -f worker
docker compose down -v
```

### Serviço local com infraestrutura em Docker

```bash
bun install
bun run infra:up          # PostgreSQL e LocalStack
bun run migration:up      # aplica as migrations
bun run sqs:setup         # cria as filas FIFO e a DLQ
bun run start             # inicia API, consumidor, outbox e worker
```

Migrations:

```bash
bun run migration:status
bun run migration:down        # reverte a última
bun scripts/migrate.ts down all
```

## Testes

Os testes de integração e concorrência usam PostgreSQL e LocalStack reais. Suba a infraestrutura
antes (`bun run infra:up`); o banco `wagering_test` é criado pelo script de inicialização do
contêiner e migrado pelos próprios testes. Cada arquivo cria filas SQS com nomes únicos.

```bash
bun run test:unit          # domínio, idempotência, eventos (sem infraestrutura)
bun run test:integration   # schema, API HTTP, consumidor SQS, atomicidade e outbox
bun run test:concurrency   # paralelismo real e processos separados
bun run test               # as três suítes
bun run typecheck
bun run lint
bun run format:check
```

`TEST_LOG_LEVEL=info` mostra os logs da aplicação durante os testes; `TEST_CHILD_LOGS=1` mostra os
logs dos processos filhos dos testes multi-instância.

### Resultado da última execução

Executado em 26/10/2026, Windows 11, Docker Desktop 29.8 (12 CPUs), Bun 1.4.4:

| Suíte        | Testes | Resultado     |
| ------------ | ------ | ------------- |
| Unidade      | 105    | 105 aprovados |
| Integração   | 55     | 55 aprovados  |
| Concorrência | 9      | 9 aprovados   |

### Cenários de concorrência

Todos verificam o estado final persistido e terminam com a invariante
`wallet.balance == saldo reconstruído pelo ledger` checada sobre todas as wallets do banco.

| Cenário                                                                                                                                                                                   | Teste                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Mesma aposta 50 vezes em paralelo: um único débito, 49 replays com o mesmo resultado                                                                                                      | `test/concurrency/hot-wallet.test.ts`                                   |
| Saldo 100.00 e duas apostas simultâneas de 80.00: uma `PROCESSED`, uma `REJECTED` (`INSUFFICIENT_FUNDS`), saldo 20.00, um débito; repetido em 20 wallets com reenvio das duas requisições | `hot-wallet.test.ts`                                                    |
| 200 apostas concorrentes de 1.00 sobre 100.00: exatamente 100 aceitas, saldo nunca negativo, cadeia do ledger sem lacunas                                                                 | `hot-wallet.test.ts`                                                    |
| 25 wallets x 20 operações em paralelo                                                                                                                                                     | `hot-wallet.test.ts`                                                    |
| 3 processos `bun src/main.ts` sobre a mesma wallet via HTTP (cada aposta enviada às 3 instâncias) e via SQS (cada mensagem entregue duas vezes)                                           | `test/concurrency/multi-instance.test.ts`                               |
| Worker morto (SIGKILL) depois do commit e antes do ack; outra instância recebe o redelivery sem duplicar o efeito                                                                         | `multi-instance.test.ts` + `test/fixtures/crash-after-commit-worker.ts` |
| Dois publishers concorrentes sobre a mesma outbox: cada evento publicado uma única vez                                                                                                    | `multi-instance.test.ts`                                                |
| `REFUND`/`ROLLBACK` entregues antes da `BET`, em duas instâncias                                                                                                                          | `multi-instance.test.ts`                                                |
| Processo morto com requisições em voo; reinício, reenvio de todas as requisições e publicação dos eventos deixados pelo processo morto                                                    | `multi-instance.test.ts`                                                |

Para executar só um cenário:

```bash
bun test --timeout 120000 test/concurrency -t "50 times"
```

### Testes de mutação

Para confirmar que os testes centrais detectam defeitos reais, cada mutação abaixo foi aplicada ao
código, os testes indicados foram executados e o código foi restaurado:

| Mutação                                                            | Resultado                                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Remover `FOR UPDATE` da leitura da wallet                          | 3 testes de concorrência falham                                                                                            |
| Remover o lock e a guarda de versão (read, calculate, update puro) | testes 80/80 e 200 apostas falham; o banco continuou consistente porque os triggers rejeitaram as escritas                 |
| Remover a re-verificação de idempotência após o lock               | o teste das 50 requisições continua passando: a constraint única e o retry são a segunda barreira (comportamento esperado) |
| Remover a re-verificação e o retry de corrida na chave única       | o teste das 50 requisições falha                                                                                           |
| Desligar a consulta de idempotência por completo                   | o teste das 50 requisições falha                                                                                           |
| Executar a unidade de trabalho sem transação SQL                   | o teste de atomicidade falha                                                                                               |
| Não reivindicar leases expiradas da outbox                         | 3 testes de recuperação da outbox falham                                                                                   |
| Marcar eventos como publicados sem enviá-los                       | o teste de publicação após queda falha                                                                                     |
| Desligar a deduplicação da inbox                                   | o teste de redelivery falha                                                                                                |
| Fazer ack antes do processamento                                   | o teste de morte entre commit e ack falha                                                                                  |

### Teste de carga

```bash
docker compose up -d --build --wait
bun run test:load
```

Variáveis: `LOAD_BASE_URL`, `LOAD_REQUESTS`, `LOAD_CONCURRENCY`, `LOAD_WALLETS`, `LOAD_HOT_SHARE`.
O script cria as wallets, dispara `BET`/`WIN` com chaves únicas, reenvia 5% para medir replays,
reconcilia todas as wallets e lê da `/metrics` os conflitos de lock e o lag da outbox.

Metodologia: uma instância `api` atendendo HTTP (pool de 20 conexões), duas instâncias `worker`
publicando a outbox, tudo em Docker Desktop no mesmo host Windows (12 CPUs). Valores medidos:

| Perfil                                        | Throughput | p50    | p95    | p99   | Erros | Conflitos de lock | Wallets inconsistentes |
| --------------------------------------------- | ---------- | ------ | ------ | ----- | ----- | ----------------- | ---------------------- |
| 3000 req, 16 clientes, sem wallet quente      | 359 req/s  | 41 ms  | 65 ms  | 89 ms | 0     | 0                 | 0                      |
| 3000 req, 50 clientes, sem wallet quente      | 195 req/s  | 142 ms | 249 ms | 5.8 s | 0     | 0                 | 0                      |
| 5000 req, 50 clientes, 20% numa wallet quente | 138 req/s  | 161 ms | 759 ms | 6.5 s | 0     | 12                | 0                      |

Leitura honesta: com mais clientes simultâneos do que conexões no pool, as requisições aguardam
conexão e a cauda passa de segundos (o histograma interno confirma que o tempo é gasto antes e
durante a transação, não na rede). Numa wallet quente, as operações são serializadas pelo lock e
quem espera ocupa uma conexão, o que piora a cauda das demais wallets; os 12 conflitos foram
`lock_timeout` resolvidos com retry, sem erro para o cliente. O lag da outbox terminou em zero ou
abaixo de 0,1 s. Ver as mitigações em `ARCHITECTURE.md`.

## API HTTP

Todas as respostas são JSON. Os erros seguem `{ "error": { "code", "message", "details?" } }`.
O header `x-correlation-id` é aceito (ou gerado) e devolvido em todas as respostas.

| Status        | Significado                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `200` / `201` | sucesso (`201` para transação `PROCESSED`, original ou replay)                                                |
| `202`         | transação aceita em `PENDING_REFERENCE`, será liquidada pelo worker                                           |
| `400`         | payload, header ou parâmetro inválido (`VALIDATION_ERROR`, `INVALID_AMOUNT`, `IDEMPOTENCY_KEY_REQUIRED`, ...) |
| `404`         | wallet ou transação inexistente                                                                               |
| `409`         | conflito: `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`, `WALLET_ALREADY_EXISTS`                |
| `422`         | rejeição por regra de negócio, transação persistida como `REJECTED` com `failureCode`                         |
| `503`         | falha transitória de infraestrutura, com `Retry-After`; reenviar com a mesma `Idempotency-Key` é seguro       |

### Criar wallet

```bash
curl -s -X POST localhost:8080/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

```json
{
  "id": "01a1780b-2ba7-746b-939a-55a924b30fa3",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1,
  "createdAt": "2026-10-26T11:49:20.423Z",
  "updatedAt": "2026-10-26T11:49:20.423Z"
}
```

Saldo inicial positivo gera a transação interna `OPENING` e o lançamento `CREDIT` na mesma transação
SQL. Uma segunda wallet para o mesmo `playerId` e moeda retorna `409 WALLET_ALREADY_EXISTS`.

### Submeter transação

```bash
curl -s -X POST localhost:8080/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"01a1780b-2ba7-746b-939a-55a924b30fa3","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

```json
{
  "transactionId": "01a1780c-0f6e-7b51-9b4f-1c8e5d7f2a10",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

- Reenvio idêntico: mesmo corpo e status, com `"idempotentReplay": true` e o saldo observado no
  processamento original.
- Mesma chave com payload diferente: `409 IDEMPOTENCY_KEY_CONFLICT`.
- `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`; `WIN` e `LOSS` podem informá-lo.
- Rejeição de negócio (`422`):

```json
{
  "transactionId": "01a177ed-18c1-73db-aa80-da91f222eda4",
  "status": "REJECTED",
  "failureCode": "INSUFFICIENT_FUNDS",
  "balance": { "amount": "20.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Os `failureCode` possíveis estão documentados em `ARCHITECTURE.md`.

### Consultas e reconciliação

```bash
curl -s localhost:8080/wallets/<walletId>
curl -s "localhost:8080/wallets/<walletId>/ledger?limit=50"
curl -s "localhost:8080/wallets/<walletId>/ledger?limit=50&cursor=<nextCursor>"
curl -s localhost:8080/wagering/transactions/<transactionId>
curl -s localhost:8080/providers/provider-a/wagering/transactions/transaction-123
curl -s -X POST localhost:8080/wallets/<walletId>/reconciliation
```

O ledger é ordenado pela versão da wallet; `nextCursor` é opaco e `null` na última página.
A reconciliação devolve `storedBalance`, `calculatedBalance`, `difference`, `consistent` e
`checkedEntries`. Divergências não são corrigidas: são logadas e contadas na métrica
`wagering_reconciliation_mismatches_total`.

### Health e métricas

```bash
curl -s localhost:8080/health/live    # processo vivo, não consulta dependências
curl -s localhost:8080/health/ready   # 200 se PostgreSQL e SQS respondem, 503 caso contrário
curl -s localhost:8080/metrics        # formato Prometheus
```

Os endpoints de health e métricas não exigem autenticação.

## Mensagens SQS

Fila `wager-transactions.fifo`, `MessageGroupId` igual ao `walletId`:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Os eventos de integração são publicados em `wagering-events.fifo`, com `MessageGroupId` igual ao
`walletId` e `MessageDeduplicationId` igual ao `eventId`.

## Estrutura

```
src/
  domain/            Money, Wallet, WagerTransaction, ledger, regras de liquidação, eventos, inbox, outbox
  application/       casos de uso, portas, idempotência, classificação de erros
  infrastructure/    MikroORM (unit of work, repositórios, migrations), SQS (consumidor, publisher), workers
  interface/         controllers HTTP, contratos de entrada (zod), filtro de erros, auth
  observability/     logger, contexto de correlação, métricas
  config/            configuração validada
scripts/             migrations, criação de filas, teste de carga
test/                unit, integration, concurrency, fixtures e suporte
```

## Problemas conhecidos e soluções

- **LocalStack exige token a partir de certas versões.** A imagem está fixada em
  `localstack/localstack:4.4`, que funciona sem conta. Não altere para `latest`.
- **Portas ocupadas.** Ajuste `POSTGRES_HOST_PORT`, `LOCALSTACK_HOST_PORT` ou `API_HOST_PORT` e as URLs
  no `.env`.
- **Windows e `bun` instalado via npm.** O comando `bun` é um shim; matar o shim não mata o processo
  real. Os testes lançam processos com `process.execPath` por isso. Se um teste for interrompido à
  força, verifique processos `bun.exe` órfãos antes de repetir a suíte.
- **SIGTERM no Windows.** O Windows não entrega SIGTERM a processos filhos; o encerramento controlado
  foi verificado em contêiner Linux (`docker compose stop worker`, saída 0 com consumidor e workers
  parados) e por teste de integração via `app.close()`.
- **Banco de testes ausente.** O `wagering_test` só é criado na primeira inicialização do volume. Se o
  volume já existia, crie-o: `docker compose exec postgres createdb -U wagering wagering_test`.
