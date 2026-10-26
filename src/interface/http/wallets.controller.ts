import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { type Request } from 'express';
import { z } from 'zod';
import {
  CreateWallet,
  GetWallet,
  GetWalletLedger,
  type LedgerPageView,
  ReconcileWallet,
  type ReconciliationView,
  type WalletView,
} from '../../application/use-cases/wallets';
import { createWalletBodySchema } from '../contracts/wager-transaction-request';
import { correlationIdOf } from './correlation';
import { parseRequest } from './request-validation';

const walletIdSchema = z.uuid();
const ledgerQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(GetWalletLedger) private readonly getLedger: GetWalletLedger,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() request: Request): Promise<WalletView> {
    const command = parseRequest(createWalletBodySchema, body, 'wallet payload');
    return this.createWallet.execute(command, correlationIdOf(request));
  }

  @Get(':walletId')
  find(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.getWallet.execute(parseRequest(walletIdSchema, walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: unknown): Promise<LedgerPageView> {
    const { cursor, limit } = parseRequest(ledgerQuerySchema, query, 'ledger query');
    return this.getLedger.execute(
      parseRequest(walletIdSchema, walletId, 'walletId'),
      cursor,
      limit,
    );
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string): Promise<ReconciliationView> {
    return this.reconcileWallet.execute(parseRequest(walletIdSchema, walletId, 'walletId'));
  }
}
