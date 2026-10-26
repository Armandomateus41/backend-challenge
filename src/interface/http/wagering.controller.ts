import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { type Request, type Response } from 'express';
import { z } from 'zod';
import { TransactionNotFoundError } from '../../application/errors';
import { GetWagerTransaction } from '../../application/use-cases/get-wager-transaction';
import { ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import { type WagerTransactionView } from '../../application/wager-transaction-result';
import { InvariantViolationError } from '../../domain/shared/errors';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import {
  idempotencyKeySchema,
  wagerTransactionBodySchema,
} from '../contracts/wager-transaction-request';
import { assertProviderAccess, providerIdentityOf } from './auth';
import { correlationIdOf } from './correlation';
import { parseRequest, RequestValidationError } from './request-validation';

/**
 * 201 PROCESSED | 202 PENDING_REFERENCE (accepted, settled asynchronously) | 422 REJECTED by a
 * business rule. Replays return the original status code and body with idempotentReplay=true.
 */
const STATUS_CODE: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 201,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 422,
};

const idSchema = z.uuid();
const pathSegment = z.string().trim().min(1).max(256);

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(GetWagerTransaction) private readonly getTransaction: GetWagerTransaction,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (idempotencyKey === undefined) {
      throw new RequestValidationError(
        'Idempotency-Key header is required',
        [],
        'IDEMPOTENCY_KEY_REQUIRED',
      );
    }
    const key = parseRequest(idempotencyKeySchema, idempotencyKey, 'Idempotency-Key header');
    const fields = parseRequest(wagerTransactionBodySchema, body, 'transaction payload');
    assertProviderAccess(request, fields.providerId);
    const outcome = await this.processWager.execute(
      { ...fields, idempotencyKey: key },
      { source: 'http', correlationId: correlationIdOf(request) },
    );
    if (outcome.kind !== 'settled') {
      throw new InvariantViolationError('HTTP requests never carry an inbox message id');
    }
    response.status(STATUS_CODE[outcome.result.status]).json(outcome.result);
  }

  @Get('wagering/transactions/:transactionId')
  async byId(
    @Param('transactionId') transactionId: string,
    @Req() request: Request,
  ): Promise<WagerTransactionView> {
    const id = parseRequest(idSchema, transactionId, 'transactionId');
    const view = await this.getTransaction.byId(id);
    // Another provider's transaction is reported as absent, not as forbidden.
    const identity = providerIdentityOf(request);
    if (identity && identity.providerId !== view.providerId) {
      throw new TransactionNotFoundError(id);
    }
    return view;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() request: Request,
  ): Promise<WagerTransactionView> {
    const provider = parseRequest(pathSegment, providerId, 'providerId');
    assertProviderAccess(request, provider);
    return this.getTransaction.byExternalId(
      provider,
      parseRequest(pathSegment, externalTransactionId, 'externalTransactionId'),
    );
  }
}
