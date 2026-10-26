import { newId } from '../../src/shared/ids';

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export interface WalletBody {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export interface TransactionResultBody {
  transactionId: string;
  status: string;
  failureCode?: string;
  balance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
}

export interface TransactionInput {
  providerId?: string;
  externalTransactionId?: string;
  playerId: string;
  walletId: string;
  roundId?: string;
  gameId?: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** Thin HTTP client used by integration and concurrency tests. */
export class ApiClient {
  constructor(readonly baseUrl: string) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  async createWallet(initial = '100.00', playerId = `player-${newId()}`): Promise<WalletBody> {
    const response = await this.request<WalletBody>('POST', '/wallets', {
      playerId,
      initialBalance: { amount: initial, currency: 'BRL' },
    });
    if (response.status !== 201) {
      throw new Error(
        `wallet creation failed: ${response.status} ${JSON.stringify(response.body)}`,
      );
    }
    return response.body;
  }

  /** Builds a full payload with defaults, returning it with its default idempotency key. */
  static transaction(input: TransactionInput): {
    key: string;
    payload: Required<Omit<TransactionInput, 'referenceExternalTransactionId'>> & {
      referenceExternalTransactionId?: string;
    };
  } {
    const providerId = input.providerId ?? 'provider-a';
    const externalTransactionId = input.externalTransactionId ?? `tx-${newId()}`;
    const payload = {
      providerId,
      externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId ?? 'round-1',
      gameId: input.gameId ?? 'fortune-chimp',
      kind: input.kind,
      money: input.money,
      ...(input.referenceExternalTransactionId
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
    };
    return { key: `${providerId}:${externalTransactionId}`, payload };
  }

  submit(payload: object, idempotencyKey: string): Promise<ApiResponse<TransactionResultBody>> {
    return this.request<TransactionResultBody>('POST', '/wagering/transactions', payload, {
      'Idempotency-Key': idempotencyKey,
    });
  }

  async submitInput(input: TransactionInput): Promise<ApiResponse<TransactionResultBody>> {
    const { key, payload } = ApiClient.transaction(input);
    return this.submit(payload, key);
  }
}
