import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { type MikroORM } from '@mikro-orm/postgresql';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/persistence';
import { GetWagerTransaction } from './application/use-cases/get-wager-transaction';
import { ProcessWagerTransaction } from './application/use-cases/process-wager-transaction';
import { ResolvePendingReferences } from './application/use-cases/resolve-pending-references';
import {
  CreateWallet,
  GetWallet,
  GetWalletLedger,
  ReconcileWallet,
} from './application/use-cases/wallets';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { BackgroundWorkers } from './infrastructure/background-workers';
import { MikroOrmUnitOfWork } from './infrastructure/database/mikro-orm-unit-of-work';
import { createOrm } from './infrastructure/database/orm';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher';
import { createSqsClient, SqsQueues } from './infrastructure/messaging/sqs';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager-consumer';
import {
  AllowAllProviderAuthenticator,
  PROVIDER_AUTHENTICATOR,
  ProviderAuthGuard,
} from './interface/http/auth';
import { HealthController } from './interface/http/health.controller';
import { HttpExceptionFilter } from './interface/http/http-exception.filter';
import { WageringController } from './interface/http/wagering.controller';
import { WalletsController } from './interface/http/wallets.controller';
import { newId } from './shared/ids';

const ORM = Symbol('ORM');

@Injectable()
class Lifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  constructor(
    @Inject(BackgroundWorkers) private readonly workers: BackgroundWorkers,
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SqsQueues) private readonly queues: SqsQueues,
  ) {}

  onApplicationBootstrap(): void {
    this.workers.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.workers.stop();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
    this.queues.client.destroy();
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: ORM, useFactory: () => createOrm(config.database) },
        {
          provide: UNIT_OF_WORK,
          useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm, config.database.lockTimeoutMs),
          inject: [ORM],
        },
        {
          provide: SqsQueues,
          useFactory: () =>
            new SqsQueues(createSqsClient(config.aws), {
              wager: config.sqs.wagerQueueName,
              dlq: config.sqs.wagerDlqName,
              events: config.sqs.eventsQueueName,
            }),
        },
        {
          provide: ProcessWagerTransaction,
          useFactory: (uow: UnitOfWork) =>
            new ProcessWagerTransaction(
              uow,
              {
                baseDelayMs: config.pendingReference.baseDelayMs,
                maxDelayMs: config.pendingReference.maxDelayMs,
              },
              { serializePerWallet: config.walletGateEnabled },
            ),
          inject: [UNIT_OF_WORK],
        },
        {
          provide: ResolvePendingReferences,
          useFactory: (uow: UnitOfWork) =>
            new ResolvePendingReferences(uow, config.pendingReference),
          inject: [UNIT_OF_WORK],
        },
        {
          provide: CreateWallet,
          useFactory: (uow: UnitOfWork) => new CreateWallet(uow, config.supportedCurrencies),
          inject: [UNIT_OF_WORK],
        },
        {
          provide: GetWallet,
          useFactory: (uow: UnitOfWork) => new GetWallet(uow),
          inject: [UNIT_OF_WORK],
        },
        {
          provide: GetWalletLedger,
          useFactory: (uow: UnitOfWork) => new GetWalletLedger(uow),
          inject: [UNIT_OF_WORK],
        },
        {
          provide: ReconcileWallet,
          useFactory: (uow: UnitOfWork) => new ReconcileWallet(uow),
          inject: [UNIT_OF_WORK],
        },
        {
          provide: GetWagerTransaction,
          useFactory: (uow: UnitOfWork) => new GetWagerTransaction(uow),
          inject: [UNIT_OF_WORK],
        },
        {
          provide: SqsWagerConsumer,
          useFactory: (queues: SqsQueues, processWager: ProcessWagerTransaction) =>
            new SqsWagerConsumer(queues, processWager, config.sqs),
          inject: [SqsQueues, ProcessWagerTransaction],
        },
        {
          provide: OutboxPublisher,
          useFactory: (uow: UnitOfWork, queues: SqsQueues) =>
            new OutboxPublisher(uow, queues, {
              owner: `${config.instanceId}:${newId()}`,
              batchSize: config.outbox.batchSize,
              leaseMs: config.outbox.leaseMs,
              retry: {
                baseDelayMs: config.outbox.retryBaseDelayMs,
                maxDelayMs: config.outbox.retryMaxDelayMs,
              },
            }),
          inject: [UNIT_OF_WORK, SqsQueues],
        },
        {
          provide: BackgroundWorkers,
          useFactory: (
            consumer: SqsWagerConsumer,
            publisher: OutboxPublisher,
            pending: ResolvePendingReferences,
          ) => new BackgroundWorkers(config, consumer, publisher, pending),
          inject: [SqsWagerConsumer, OutboxPublisher, ResolvePendingReferences],
        },
        { provide: PROVIDER_AUTHENTICATOR, useClass: AllowAllProviderAuthenticator },
        { provide: APP_GUARD, useClass: ProviderAuthGuard },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        Lifecycle,
      ],
    };
  }
}
