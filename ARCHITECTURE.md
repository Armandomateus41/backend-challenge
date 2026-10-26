# Arquitetura

Este documento descreve como o serviço garante as invariantes financeiras e por que cada decisão
foi tomada. Tudo o que está aqui corresponde ao código e foi exercitado pelos testes indicados no
`README.md`.

## 1. Visão geral e módulos

```
HTTP (Nest controllers)      SQS consumer (wager-transactions.fifo)
          \                    /
           ProcessWagerTransaction  (mesmo caso de uso para as duas entradas)
                     |
        WagerSettlement (domínio puro) + Wallet + WagerTransaction + WalletLedgerEntry
                     |
        UnitOfWork (MikroORM, uma transação SQL) -> wallets, wager_transactions,
                     wallet_ledger_entries, inbox_messages, outbox_messages
                     |
        OutboxPublisher -> wagering-events.fifo     ResolvePendingReferences (worker)
```

| Camada          | Diretório            | Responsabilidade                                                                                                                                                |
| --------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domínio         | `src/domain`         | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `WagerSettlement`, eventos, `InboxMessage`, `OutboxMessage`. Sem dependência de NestJS, ORM ou SQS. |
| Aplicação       | `src/application`    | Casos de uso, portas de persistência (`UnitOfWork`, repositórios), hash de idempotência, classificação de erros.                                                |
| Infraestrutura  | `src/infrastructure` | Repositórios PostgreSQL, unit of work, migrations, cliente SQS, consumidor, publisher da outbox, loops de background.                                           |
| Interface       | `src/interface`      | Controllers HTTP, contratos de entrada em zod (compartilhados com o SQS), filtro de erros, guarda de autenticação.                                              |
| Observabilidade | `src/observability`  | Logger JSON, contexto de correlação (AsyncLocalStorage), métricas Prometheus.                                                                                   |

Os casos de uso são classes simples instanciadas por factories no módulo Nest; só os adaptadores
conhecem o framework.

## 2. Modelo de domínio e invariantes

Todas as entidades têm construtor privado, factories (`create`, `open`, `enqueue`, `receive`) e
`rehydrate`. A reidratação reconstrói o estado persistido sem reaplicar regras de transição.

### Money

- Valor guardado como inteiro de centavos em `bigint` (escala fixa 2). Nenhuma operação passa por
  `number`.
- Entrada aceita somente string decimal sem sinal, sem expoente, sem zeros à esquerda e com até 2
  casas (`"25"`, `"25.5"` e `"25.50"` são válidos; `"-1"`, `"1e3"`, `"NaN"`, `"Infinity"`, `""`,
  `"1.001"`, `"01.00"` e números JSON são rejeitados). Limite de 18 dígitos inteiros, igual ao
  `NUMERIC(20,2)` do banco.
- Saída sempre com escala 2 (`toString`, `toJSON` -> `{ amount: "25.50", currency: "BRL" }`).
- `add`, `subtract` e comparações entre moedas diferentes lançam `CurrencyMismatchError`. `negate`
  existe para uso interno; valores negativos nunca vêm de contratos de entrada.
- Persistência: colunas `NUMERIC(20,2)` + `char(3)`. As leituras usam `::text`, então o valor vai do
  banco ao domínio sem passar por ponto flutuante.

Escolhi `bigint` em vez de uma biblioteca decimal porque a escala é fixa e todas as operações
necessárias (soma, subtração, comparação) são exatas em inteiros, sem dependência extra.

### Wallet (aggregate root)

- Uma por `(playerId, currency)`.
- `credit`/`debit` são o único caminho para mudar o saldo e devolvem o `WalletLedgerEntry`
  correspondente, com `walletVersion` igual à nova versão. Saldo e ledger não podem divergir no
  modelo.
- `debit` recusa deixar o saldo negativo; movimentos de valor zero são recusados, portanto a versão
  só muda quando o saldo muda.
- `version` começa em 1 na abertura (inclusive quando a abertura gera o lançamento `OPENING`).

### WalletLedgerEntry

Imutável: campos `readonly`, nenhum método de mutação. `create` valida valor positivo, saldos não
negativos e `balanceBefore +/- money == balanceAfter`. Uma transação gera no máximo um lançamento;
`LOSS` e transações `REJECTED` não geram lançamento.

### WagerTransaction e transições

```
PENDING ──> PROCESSED          (terminal)
   │   ──> REJECTED           (terminal)
   │   ──> FAILED             (terminal)
   └──> PENDING_REFERENCE ──> PROCESSED | REJECTED | FAILED
```

- Qualquer transição a partir de um estado terminal lança `InvalidTransactionStateError` (erro de
  programação, não caminho de negócio).
- `PENDING` existe apenas em memória: a decisão é tomada antes do primeiro `INSERT`, dentro da mesma
  transação SQL.
- `OPENING` só é criado por `WagerTransaction.createOpening` na abertura da wallet; `create` o
  recusa e o contrato de entrada (zod) não o aceita.
- `FAILED` é usado pelo worker de pendências quando a resolução encontra um erro permanente que não
  é de negócio; a transação fica auditável com `PROCESSING_ERROR` e deixa de ser reprocessada.
- Cada transação guarda `observedBalance`, o saldo no momento em que atingiu o estado atual. É ele
  que o replay devolve.

## 3. Regras de negócio

| Operação   | Efeito                                       | Referência                            |
| ---------- | -------------------------------------------- | ------------------------------------- |
| `BET`      | débito; `INSUFFICIENT_FUNDS` se faltar saldo | não aceita                            |
| `WIN`      | crédito                                      | opcional, deve ser uma `BET`          |
| `LOSS`     | nenhum (valor zero permitido)                | opcional, deve ser uma `BET`          |
| `REFUND`   | crédito igual ao da `BET`                    | obrigatória, `BET`                    |
| `ROLLBACK` | movimento inverso ao da referência           | obrigatória, `BET`, `WIN` ou `REFUND` |

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ser do mesmo
provider, player, wallet, moeda e rodada, e estar `PROCESSED`. Reversões exigem valor igual ao da
referência.

Interpretações adotadas:

1. **Uma referência é revertida no máximo uma vez, somando `REFUND` e `ROLLBACK`.** A leitura literal
   "uma vez por tipo" permitiria `REFUND` e `ROLLBACK` da mesma `BET`, creditando duas vezes. Um
   `ROLLBACK` de um `REFUND` continua permitido, porque reverte outra transação.
2. **`WIN`/`LOSS` com referência ausente também aguardam em `PENDING_REFERENCE`**, para não creditar
   um ganho de uma aposta que ainda não existe.
3. **Referência que existe mas ainda está pendente** mantém a dependente pendente; se a janela
   expirar nesse estado, a rejeição usa `REFERENCE_NOT_PROCESSED`.
4. **Reversão que deixaria saldo negativo** (por exemplo, `ROLLBACK` de um `WIN` já gasto) é
   `REJECTED` com `REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS`.

### Códigos de falha (`failureCode`)

| Código                                                                                                              | Situação                                                   | Ação esperada do provedor     |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------- |
| `INSUFFICIENT_FUNDS`                                                                                                | `BET` maior que o saldo                                    | não reenviar a mesma aposta   |
| `REVERSAL_INSUFFICIENT_FUNDS`                                                                                       | reversão deixaria saldo negativo                           | escalar para operação         |
| `CURRENCY_MISMATCH`                                                                                                 | moeda diferente da wallet                                  | corrigir payload              |
| `WALLET_PLAYER_MISMATCH`                                                                                            | `playerId` não é dono da wallet                            | corrigir payload              |
| `REFERENCE_NOT_FOUND`                                                                                               | referência não chegou dentro da janela                     | verificar a operação original |
| `REFERENCE_NOT_PROCESSED`                                                                                           | referência rejeitada, falhada ou ainda pendente ao expirar | não reenviar                  |
| `REFERENCE_KIND_NOT_ALLOWED`                                                                                        | tipo referenciado incompatível                             | corrigir payload              |
| `REFERENCE_PLAYER_MISMATCH`, `REFERENCE_WALLET_MISMATCH`, `REFERENCE_CURRENCY_MISMATCH`, `REFERENCE_ROUND_MISMATCH` | referência de outro contexto                               | corrigir payload              |
| `REFERENCE_AMOUNT_MISMATCH`                                                                                         | valor diferente (reversão parcial fora de escopo)          | corrigir payload              |
| `REFERENCE_ALREADY_REVERSED`                                                                                        | referência já revertida                                    | não reenviar                  |
| `PROCESSING_ERROR`                                                                                                  | erro permanente registrado como `FAILED`                   | escalar                       |

Erros que não geram transação persistida usam códigos de API: `VALIDATION_ERROR`, `INVALID_AMOUNT`,
`INVALID_CURRENCY`, `AMOUNT_OUT_OF_RANGE`, `KIND_NOT_ALLOWED`, `REFERENCE_REQUIRED`,
`REFERENCE_NOT_ALLOWED`, `REFERENCE_INVALID`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_CONFLICT`,
`EXTERNAL_TRANSACTION_CONFLICT`, `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`,
`WALLET_ALREADY_EXISTS`, `UNSUPPORTED_CURRENCY`, `INVALID_CURSOR`, `SERVICE_UNAVAILABLE`.

## 4. Concorrência

**Estratégia: lock pessimista por wallet.** `ProcessWagerTransaction` executa, numa transação
`READ COMMITTED`:

1. (SQS) `INSERT` na inbox com `ON CONFLICT DO NOTHING`; se já existia, é redelivery: nada é feito.
2. Busca pela `Idempotency-Key` sem lock (atalho para replays).
3. `SELECT ... FROM wallets WHERE id = ? FOR UPDATE`: serializa todas as operações daquela wallet
   entre todas as instâncias, sem afetar outras wallets.
4. Nova busca pela chave, agora depois do lock: em `READ COMMITTED` cada comando enxerga o último
   commit, então uma requisição idêntica que terminou enquanto esta esperava é encontrada e
   devolvida como replay.
5. Resolução da referência, `WagerSettlement.settle` (domínio puro) e persistência da transação, do
   saldo, do lançamento e dos eventos.

Por que pessimista: a unidade de concorrência é a wallet e o conflito é o caso comum numa wallet
quente. Com lock otimista, as tentativas concorrentes repetiriam o trabalho e esgotariam os retries
justamente onde há disputa; com `UPDATE ... WHERE balance >= ?` o débito ficaria correto, mas a
idempotência, a resolução de referências e o lançamento do ledger precisariam de outra
sincronização. O lock de linha resolve tudo com um mecanismo só e funciona com qualquer número de
instâncias, porque vive no PostgreSQL.

Defesas adicionais:

- `UPDATE wallets ... WHERE id = ? AND version = ?`: se o lock fosse removido por engano, a escrita
  falharia em vez de perder atualização.
- `lock_timeout` por transação (`DATABASE_LOCK_TIMEOUT_MS`): uma wallet travada vira erro transitório
  (`55P03`) em vez de prender conexões indefinidamente.
- Deadlock, serialização e lock timeout são reclassificados como `TransientInfrastructureError` e
  repetidos até 3 vezes dentro da mesma chamada; persistindo, HTTP responde `503` e o SQS agenda
  retry.
- Ordem de locks consistente (wallet, depois linha da transação) entre o fluxo online e o worker de
  pendências, evitando deadlock entre eles.

Não existe lock global: duas wallets nunca disputam o mesmo lock.

## 5. Idempotência

- `Idempotency-Key` é obrigatório no HTTP; no SQS vem em `data.idempotencyKey`. A sugestão é
  `"{providerId}:{externalTransactionId}"`.
- `payloadHash = SHA-256(JSON canônico)` de `providerId`, `externalTransactionId`, `playerId`,
  `walletId`, `roundId`, `gameId`, `kind`, `money` (normalizado para escala 2) e
  `referenceExternalTransactionId`. JSON canônico: chaves ordenadas por code point em todos os níveis,
  membros `undefined` omitidos, sem espaços. A chave e metadados de transporte não entram no hash,
  portanto HTTP e SQS produzem o mesmo hash para a mesma operação.
- Mesma chave e mesmo hash: replay com `idempotentReplay: true`, mesmo status HTTP e o
  `observedBalance` original.
- Mesma chave e hash diferente: `409 IDEMPOTENCY_KEY_CONFLICT` (no SQS, DLQ).
- Mesmo `(providerId, externalTransactionId)` com outra chave: `409 EXTERNAL_TRANSACTION_CONFLICT`.
- A fonte de verdade é a tabela `wager_transactions`, com `UNIQUE (idempotency_key)` e
  `UNIQUE (provider_id, external_transaction_id)`. Se dois processos com a mesma chave chegarem a
  wallets diferentes (payloads diferentes), a violação de unicidade vira `IdempotencyRaceError`, a
  operação é repetida e cai no caminho de conflito.
- Transações `REJECTED` também são persistidas e respondem replays com o mesmo `422`.

Nada disso depende de memória do processo ou da deduplicação da fila: reinícios e várias instâncias
enxergam o mesmo estado.

## 6. Transações e schema do PostgreSQL

Uma transação SQL contém tudo o que uma operação altera: linha em `wager_transactions`, `UPDATE` da
wallet, lançamento no ledger, linha da inbox (entrada SQS) e eventos da outbox. A ordem de escrita é
transação, saldo, ledger, outbox.

Garantias aplicadas no banco (migration `Migration20261026000000InitialSchema`):

| Garantia                               | Mecanismo                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Saldo nunca negativo                   | `CHECK (balance >= 0)` em `wallets`, `balance_before`, `balance_after`                                                             |
| Uma wallet por player e moeda          | `UNIQUE (player_id, currency)`                                                                                                     |
| Idempotência                           | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`                                                        |
| Um lançamento por transação e wallet   | `UNIQUE (wallet_id, transaction_id)`                                                                                               |
| Ordem do ledger                        | `UNIQUE (wallet_id, wallet_version)`                                                                                               |
| Aritmética do lançamento               | `CHECK` de `balance_after = balance_before +/- amount`                                                                             |
| Ledger append-only                     | trigger que rejeita `UPDATE` e `DELETE`                                                                                            |
| Cadeia de saldos                       | trigger `BEFORE INSERT`: `balance_before` igual ao `balance_after` anterior, moeda igual à da wallet                               |
| Lançamento só para transação liquidada | trigger: a transação deve estar `PROCESSED`, não ser `LOSS`, e ter mesmo valor, moeda e wallet                                     |
| Saldo materializado igual ao ledger    | constraint trigger `DEFERRABLE INITIALLY DEFERRED`: no commit, `balance` e `version` da wallet devem bater com o último lançamento |
| Estados terminais imutáveis            | trigger em `wager_transactions` que rejeita mudanças em linhas terminais, alterações de colunas de negócio e `DELETE`              |
| Reversão única                         | índice único parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` `PROCESSED`                                            |
| Coerência de estado                    | `CHECK`s ligando `status` a `failure_code`, `processed_at`, `next_attempt_at` e `observed_balance`                                 |
| Inbox                                  | chave primária `(consumer_name, message_id)`                                                                                       |
| Outbox                                 | conteúdo imutável, mensagem publicada não volta a pendente, publicada não pode ter lease                                           |

Os testes de mutação mostraram o valor dessas defesas: com o lock e a guarda de versão removidos do
código, as requisições concorrentes falharam, mas o banco permaneceu consistente.

A migration é reversível (`down` remove tabelas e funções) e é testada com `down` seguido de `up`.

## 7. Inbox e transactional outbox

### Inbox

`inbox_messages` guarda `(consumer_name, message_id)`, o hash do payload, o vínculo com a transação e
os instantes de recebimento e processamento. O registro é inserido na mesma transação SQL do efeito
financeiro: se a linha existe, o efeito foi confirmado. Um redelivery (crash entre commit e ack,
visibility timeout expirado, duplicata do produtor) encontra a linha e é confirmado sem efeito.
Entregas concorrentes do mesmo `messageId` aguardam no índice único e só uma confirma.

O `messageId` usado é o do envelope (estável entre reenvios do produtor), não o `MessageId` gerado
pelo SQS.

### Outbox

- Eventos são gravados em `outbox_messages` na mesma transação da alteração. Nada é publicado antes
  do commit.
- O publisher reivindica lotes com `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`,
  gravando `locked_by` e `locked_until`. Publishers concorrentes dividem as linhas sem bloqueio mútuo.
- Envia em lotes de até 10 (`SendMessageBatch`), com `MessageGroupId = walletId` e
  `MessageDeduplicationId = eventId`. Falhas por mensagem são reagendadas com backoff exponencial
  (`attempts`, `next_attempt_at`, `last_error`).
- A gravação do resultado só acontece se o publisher ainda for dono da lease
  (`WHERE locked_by = ?`); uma lease perdida é registrada em log e não sobrescreve o novo dono.
- Recuperação:
  - processo morre depois do commit e antes de publicar: as linhas continuam pendentes e qualquer
    instância as publica;
  - processo morre depois de reivindicar: a lease expira (`OUTBOX_LEASE_MS`) e outra instância assume;
  - processo morre depois de enviar e antes de marcar: o evento é reenviado com o mesmo `eventId`; a
    fila FIFO descarta a cópia dentro da janela de 5 minutos e consumidores devem deduplicar por
    `eventId` fora dela.
- Eventos novos nascem com `next_attempt_at` nulo (elegíveis imediatamente) e todo agendamento é
  ancorado no relógio do PostgreSQL (`now() + atraso`), o mesmo relógio usado nas consultas de claim.
  Isso foi corrigido durante os testes, quando a comparação entre o relógio da aplicação e o do banco
  atrasava eventos recém-criados.
- O publisher nunca descarta um evento: repete indefinidamente com atraso máximo configurável. A
  métrica de lag e o contador de tentativas são o sinal de alerta.

## 8. SQS: garantias, retries e DLQ

- Filas FIFO com deduplicação explícita. `MessageGroupId = walletId` dá ordem por wallet e evita que
  duas instâncias processem a mesma wallet ao mesmo tempo, mas isso é otimização: a correção vem do
  banco (lock, unicidade, inbox).
- O consumidor processa grupos diferentes em paralelo e mensagens do mesmo grupo em ordem. Quando
  uma mensagem falha de forma transitória, as seguintes do mesmo grupo são liberadas
  (visibilidade 0) para não furarem a ordem.
- Classificação de erros (mesma função usada pelo HTTP):

| Categoria                 | Exemplos                                                                                | Tratamento                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Rejeição de negócio       | `INSUFFICIENT_FUNDS`, referências inválidas                                             | transação `REJECTED` persistida, ack                                                                                                  |
| Permanente                | JSON inválido, schema inválido, `OPENING`, wallet inexistente, conflito de idempotência | envio para a DLQ com `deadLetterReason`, `deadLetterDetail`, `receiveCount`; remoção da fila de origem                                |
| Transitória ou inesperada | lock timeout, deadlock, banco indisponível, erro desconhecido                           | `ChangeMessageVisibility` com backoff `2s * 2^(n-1)` limitado a 300 s; ao atingir `SQS_MAX_ATTEMPTS`, DLQ com `MAX_ATTEMPTS_EXCEEDED` |

- A fila principal também tem `RedrivePolicy` com `maxReceiveCount = SQS_MAX_ATTEMPTS + 2`, como rede
  de segurança para mensagens que derrubam o processo antes de serem classificadas.
- Ack (`DeleteMessage`) somente depois do commit. Se o ack falhar, a mensagem volta e a inbox a
  reconhece.
- Shutdown: `SIGTERM` aciona os hooks do Nest; o consumidor interrompe o long polling, conclui as
  mensagens em andamento (até `SHUTDOWN_TIMEOUT_MS`) e devolve a visibilidade das recebidas e não
  iniciadas. Em paralelo, os loops da outbox e de pendências terminam a iteração em curso. Em seguida
  fecham o servidor HTTP, o pool do PostgreSQL e o cliente SQS. Verificado em contêiner Linux com
  `docker compose stop worker` (saída 0) e por teste de integração que encerra uma instância com
  mensagens pendentes e confirma que nenhuma ficou presa em voo.

## 9. Referências fora de ordem

- Transação com referência ausente é gravada como `PENDING_REFERENCE` com `next_attempt_at`. A
  resposta HTTP é `202` e o evento `WagerTransactionPendingReference` é emitido.
- O worker reivindica linhas vencidas com `FOR UPDATE SKIP LOCKED` e empurra `next_attempt_at` como
  lease. Cada linha é então liquidada com o mesmo lock de wallet do fluxo online.
- Quando a transação referenciada é processada, as dependentes pendentes são marcadas como vencidas
  na mesma transação, para que o worker as pegue no próximo ciclo.
- Backoff: `PENDING_REFERENCE_BASE_DELAY_MS * 2^(tentativa-1)`, limitado a
  `PENDING_REFERENCE_MAX_DELAY_MS`. Com os padrões (1 s, 60 s, 8 tentativas) a janela é de cerca de
  3 minutos. Esse prazo cobre a cadeia de retries do SQS de uma `BET` com falhas transitórias (2, 4,
  8 e 16 s) com folga, sem deixar créditos órfãos pendentes por muito tempo. Esgotada a janela, a
  transação vira `REJECTED` com `REFERENCE_NOT_FOUND` e o evento `WagerTransactionRejected` é
  publicado.

## 10. Eventos de integração

Envelope (`IntegrationEvent<T>`, classe abstrata com uma subclasse por evento; `eventType` e
`version` são fixados no tipo):

```json
{
  "eventId": "uuid v7",
  "eventType": "WalletBalanceChanged",
  "aggregateId": "walletId ou transactionId",
  "correlationId": "id da requisição ou da mensagem",
  "causationId": "messageId de origem, quando houver",
  "occurredAt": "ISO-8601",
  "version": 1,
  "data": {}
}
```

| Evento                             | Quando                                                    | `data`                                                                                              |
| ---------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `WagerTransactionProcessed`        | qualquer transação aplicada, inclusive `LOSS` e `OPENING` | dados da transação, `referenceTransactionId?`, `balance`, `processedAt`                             |
| `WagerTransactionRejected`         | rejeição de negócio, inclusive expiração de referência    | dados da transação, `failureCode`, `referenceTransactionId?`, `balance`                             |
| `WalletBalanceChanged`             | somente quando houve lançamento no ledger                 | `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` |
| `WagerTransactionPendingReference` | transação aguardando referência                           | dados da transação                                                                                  |

Valores monetários são sempre `MoneyProps` com string decimal. `walletVersion` permite ao consumidor
ordenar e descartar `WalletBalanceChanged` antigos.

## 11. Observabilidade

- **Logs**: JSON via pino, com `service`, `instanceId`, `level`, `time` e o contexto de correlação
  (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`) propagado por
  AsyncLocalStorage desde o middleware HTTP ou o consumidor. Corpos de requisição, headers e payloads
  financeiros completos não são logados; caminhos sensíveis são removidos por `redact`.
- **Métricas** (`GET /metrics`):

| Métrica                                                           | Uso                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `wagering_transactions_total{status,kind,source}`                 | transações por estado                                       |
| `wagering_duplicates_total{type,source}`                          | replays de idempotência e redeliveries barrados pela inbox  |
| `wagering_idempotency_conflicts_total{source}`                    | chave reutilizada com payload diferente                     |
| `wagering_retries_total{operation}`                               | retries de transação, mensagem SQS, publicação e pendências |
| `wagering_dlq_messages_total{reason}`                             | mensagens enviadas à DLQ                                    |
| `wagering_lock_conflicts_total{type}`                             | lock timeout, deadlock e corridas de chave única            |
| `wagering_outbox_pending_messages`, `wagering_outbox_lag_seconds` | tamanho e idade da outbox                                   |
| `wagering_outbox_published_total{event_type}`                     | eventos publicados                                          |
| `wagering_processing_duration_seconds{source,outcome}`            | latência de processamento                                   |
| `wagering_reconciliation_mismatches_total`                        | reconciliações divergentes                                  |
| `wagering_pending_reference_expired_total`                        | referências expiradas                                       |

- **Health**: `/health/live` não consulta dependências; `/health/ready` testa PostgreSQL (`SELECT 1`) e
  SQS (`GetQueueAttributes`) com timeout de 2 s e responde `503` se algum falhar.

## 12. Autenticação

Decisão: não implementada neste desafio, conforme permitido. O ponto de extensão está no código:
`ProviderAuthGuard` é um guard global que libera rotas marcadas com `@Public()` (health e métricas) e
delega as demais a um `ProviderAuthenticator`; a implementação registrada é
`AllowAllProviderAuthenticator`.

Desenho que eu adotaria:

1. Keycloak (ou outro IdP OIDC) com um client confidencial por provedor de jogos, fluxo
   `client_credentials`.
2. Um `JwtProviderAuthenticator` valida assinatura pelo JWKS do IdP (com cache), `iss`, `aud` e `exp`,
   e expõe o claim `provider_id` no request.
3. O controller compara `provider_id` com o `providerId` do payload e responde `403` se divergirem.
4. Mensagens SQS são canal interno confiável (autorização via IAM), mas o `providerId` da mensagem
   continua sujeito às regras de domínio (referências só resolvem dentro do mesmo provider).

Não há tabela própria de usuários nem senhas.

## 13. ORM e estratégia transacional

MikroORM 7 é usado para pool de conexões, `EntityManager.transactional()` com nível de isolamento
explícito e migrations versionadas (`Migrator` com lista explícita de migrations, transacionais e
`allOrNothing`). Cada unidade de trabalho usa um `fork()` do EntityManager, então requisições
concorrentes não compartilham identity map nem conexão.

Os repositórios executam SQL parametrizado pelo EntityManager transacional (`em.execute`) e mapeiam
linhas para o domínio com funções explícitas, em vez de entidades decoradas e flush do Unit of Work.
Motivos:

- os caminhos críticos dependem de SQL que precisa estar visível na revisão: `FOR UPDATE`,
  `FOR UPDATE SKIP LOCKED`, `ON CONFLICT DO NOTHING`, `UPDATE ... WHERE version = ?`, `RETURNING`;
- a ordem das escritas importa para os triggers (transação antes do lançamento) e o flush
  automático decide a ordem pelo grafo de dependências;
- o domínio permanece livre de metadados do ORM, como pede o enunciado para `Money`.

Leituras que precisam de consistência entre tabelas (reconciliação) usam uma transação
`REPEATABLE READ` somente leitura.

## 14. Testes

- Unidade: `Money` (escala, entradas inválidas, aritmética, moedas), `Wallet`, ledger, transições,
  todas as regras de `WagerSettlement`, hash canônico, idempotência do caso de uso com repositório em
  memória, envelopes de eventos, outbox, inbox e backoff.
- Integração (PostgreSQL e LocalStack reais): migrations reversíveis e cada constraint ou trigger;
  API HTTP completa; consumidor SQS com inbox, redelivery, DLQ, retry com lock real segurado por outra
  conexão e shutdown com trabalho pendente; atomicidade com falha injetada depois das escritas de
  saldo e ledger; recuperação da outbox.
- Concorrência: paralelismo real dentro de um processo e entre processos separados, inclusive
  `SIGKILL` entre commit e ack e durante requisições em voo.
- Mutação: ver tabela no `README.md`.

## 15. Trade-offs e limitações conhecidas

- **Wallet quente.** O lock pessimista serializa a wallet; o throughput dela é limitado pelo tempo em
  que o lock fica retido (algumas consultas por operação). Requisições à espera ocupam conexões do
  pool, o que aumenta a latência das demais wallets na mesma instância (medido no teste de carga).
  Mitigações possíveis: fila em memória por wallet para limitar quantas requisições de uma mesma
  wallet disputam o pool, `lock_timeout` menor com retry no cliente, pool maior atrás de um
  PgBouncer e controle de admissão (no máximo N requisições em voo por instância).
- **Ordem de eventos entre publishers.** Com vários publishers, dois eventos da mesma wallet podem ser
  publicados fora de ordem. Consumidores devem usar `walletVersion` e deduplicar por `eventId`.
- **Janela de deduplicação da FIFO** é de 5 minutos; fora dela a deduplicação é responsabilidade do
  consumidor do evento.
- **Retenção.** Não há limpeza de linhas antigas da inbox e da outbox publicada; em produção seria um
  job de retenção por idade.
- **Moedas.** O modelo é multi-moeda e os conflitos de moeda são testados, mas apenas `BRL` está
  habilitado (`SUPPORTED_CURRENCIES`). A escala é fixa em 2 casas para todas as moedas.
- **Reversão parcial** não é suportada (valor deve ser igual ao da referência).
- **Wallet inexistente via SQS** vai para a DLQ em vez de ser persistida, porque não há wallet à qual
  vincular a transação.
- **OpenTelemetry e dashboards** não foram implementados; a correlação é feita por logs e métricas.
- **Autenticação** não implementada (seção 12).
