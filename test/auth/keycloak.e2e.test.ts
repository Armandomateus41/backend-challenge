/**
 * End-to-end authentication against a real Keycloak (docker compose --profile auth up -d keycloak).
 * Run with `bun run test:auth`. The test fails, rather than skips, when Keycloak is unreachable.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '../../src/shared/ids';
import { ApiClient } from '../support/api-client';
import {
  type RunningApp,
  startApp,
  testConfig,
  TestDatabase,
  TestQueues,
  uniqueSuffix,
} from '../support/environment';

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const REALM_URL = `${KEYCLOAK_URL}/realms/wagering`;

let db: TestDatabase;
let queues: TestQueues;
let running: RunningApp;

async function clientCredentialsToken(clientId: string, secret: string): Promise<string> {
  const response = await fetch(`${REALM_URL}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret,
    }),
  });
  if (response.status !== 200) {
    throw new Error(`Keycloak token request failed with ${response.status}`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

beforeAll(async () => {
  const discovery = await fetch(`${REALM_URL}/.well-known/openid-configuration`).catch(() => {
    throw new Error(
      `Keycloak is not reachable at ${KEYCLOAK_URL}; start it with: docker compose --profile auth up -d --wait keycloak`,
    );
  });
  const { issuer, jwks_uri } = (await discovery.json()) as { issuer: string; jwks_uri: string };
  db = await TestDatabase.connect();
  const config = testConfig(uniqueSuffix(), {
    AUTH_ENABLED: 'true',
    AUTH_ISSUER: issuer,
    AUTH_JWKS_URL: jwks_uri,
    AUTH_AUDIENCE: 'wagering-api',
  });
  queues = await TestQueues.create(config);
  running = await startApp(config);
});

afterAll(async () => {
  await running?.close();
  await queues?.destroy();
  await db?.close();
});

describe('Keycloak client credentials', () => {
  test('tokens issued per provider authorize only that provider', async () => {
    const providerA = await clientCredentialsToken('provider-a', 'provider-a-local-secret');
    const providerB = await clientCredentialsToken('provider-b', 'provider-b-local-secret');
    const api = new ApiClient(running.baseUrl);
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    const anonymous = await api.request('POST', '/wallets', {});
    expect(anonymous.status).toBe(401);

    const wallet = await api.request<{ id: string; playerId: string }>(
      'POST',
      '/wallets',
      { playerId: `p-${newId()}`, initialBalance: { amount: '50.00', currency: 'BRL' } },
      auth(providerA),
    );
    expect(wallet.status).toBe(201);

    const { key, payload } = ApiClient.transaction({
      providerId: 'provider-a',
      playerId: wallet.body.playerId,
      walletId: wallet.body.id,
      kind: 'BET',
      money: { amount: '5.00', currency: 'BRL' },
    });
    const ownBet = await api.request('POST', '/wagering/transactions', payload, {
      ...auth(providerA),
      'Idempotency-Key': key,
    });
    expect(ownBet.status).toBe(201);

    const impersonation = await api.request<{ error: { code: string } }>(
      'POST',
      '/wagering/transactions',
      { ...payload, externalTransactionId: `tx-${newId()}` },
      { ...auth(providerB), 'Idempotency-Key': `provider-a:${newId()}` },
    );
    expect(impersonation.status).toBe(403);
    expect(impersonation.body.error.code).toBe('PROVIDER_MISMATCH');
    expect(await db.walletState(wallet.body.id)).toMatchObject({ balance: '45.00', debits: 1 });
  });
});
