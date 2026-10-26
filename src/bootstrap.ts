import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { type AppConfig } from './config/app-config';
import { correlationMiddleware } from './interface/http/correlation';
import { configureLogger, NestPinoLogger } from './observability/logger';

export async function createApp(config: AppConfig): Promise<INestApplication> {
  configureLogger({ level: config.logLevel, instanceId: config.instanceId });
  const app = await NestFactory.create(AppModule.forRoot(config), {
    logger: new NestPinoLogger(),
    bufferLogs: false,
  });
  app.use(correlationMiddleware);
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  return app;
}
