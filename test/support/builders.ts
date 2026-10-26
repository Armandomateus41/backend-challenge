import { Money } from '../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { newId } from '../../src/shared/ids';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

export const PLAYER_ID = 'player-1';
export const PROVIDER_ID = 'provider-a';
export const ROUND_ID = 'round-1';

export function walletWith(balance: string, playerId = PLAYER_ID): Wallet {
  return Wallet.open({
    id: newId(),
    playerId,
    initialBalance: brl(balance),
    at: new Date(),
    opening: { entryId: newId(), transactionId: newId() },
  }).wallet;
}

export function transaction(
  wallet: Wallet,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${newId()}`;
  return WagerTransaction.create({
    id: newId(),
    providerId: PROVIDER_ID,
    externalTransactionId,
    idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: ROUND_ID,
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    createdAt: new Date(),
    ...overrides,
  });
}
