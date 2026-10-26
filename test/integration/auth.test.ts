import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
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
import { freePort } from '../support/processes';

const ISSUER = 'http://issuer.test/realms/wagering';
const AUDIENCE = 'wagering-api';

let db: TestDatabase;
let queues: TestQueues;
let running: RunningApp;
let jwksServer: ReturnType<typeof Bun.serve>;
let signingKey: CryptoKey;
let foreignKey: CryptoKey;

beforeAll(async () => {
  db = await TestDatabase.connect();
  await db.reset();
  const trusted = await generateKeyPair('RS256');
  const untrusted = await generateKeyPair('RS256');
  signingKey = trusted.privateKey;
  foreignKey = untrusted.privateKey;
  const jwk = { ...(await exportJWK(trusted.publicKey)), kid: 'trusted', alg: 'RS256', use: 'sig' };
  // Real HTTP JWKS endpoint, fetched by the application exactly as it would fetch Keycloak's.
  jwksServer = Bun.serve({ port: freePort(), fetch: () => Response.json({ keys: [jwk] }) });

  const config = testConfig(uniqueSuffix(), {
    AUTH_ENABLED: 'true',
    AUTH_ISSUER: ISSUER,
    AUTH_JWKS_URL: `http://127.0.0.1:${jwksServer.port}/certs`,
    AUTH_AUDIENCE: AUDIENCE,
  });
  queues = await TestQueues.create(config);
  running = await startApp(config);
});

afterAll(async () => {
  await running.close();
  await queues.destroy();
  await jwksServer.stop(true);
  await db.close();
});

interface TokenOptions {
  providerId?: string;
  key?: CryptoKey;
  kid?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
}

function token(options: TokenOptions = {}): Promise<string> {
  const claims = options.providerId === undefined ? {} : { provider_id: options.providerId };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'trusted' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject('service-account')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(options.key ?? signingKey);
}

function client(bearer?: string) {
  return {
    request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      return new ApiClient(running.baseUrl).request<T>(method, path, body, {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      });
    },
  };
}

async function walletAs(bearer: string) {
  const response = await client(bearer).request<{ id: string; playerId: string }>(
    'POST',
    '/wallets',
    { playerId: `p-${newId()}`, initialBalance: { amount: '100.00', currency: 'BRL' } },
  );
  expect(response.status).toBe(201);
  return response.body;
}

describe('provider authentication', () => {
  test('health and metrics stay public', async () => {
    expect((await client().request('GET', '/health/live')).status).toBe(200);
    expect((await client().request('GET', '/health/ready')).status).toBe(200);
    const metrics = await fetch(`${running.baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
  });

  test.each<[string, () => Promise<string | undefined>]>([
    ['missing token', () => Promise.resolve(undefined)],
    ['unknown signing key', () => token({ providerId: 'provider-a', key: foreignKey })],
    ['expired token', () => token({ providerId: 'provider-a', expiresIn: '-1m' })],
    ['wrong issuer', () => token({ providerId: 'provider-a', issuer: 'http://evil.test' })],
    ['wrong audience', () => token({ providerId: 'provider-a', audience: 'other-api' })],
    ['missing provider claim', () => token()],
  ])('rejects %s with 401', async (_name, makeToken) => {
    const response = await client(await makeToken()).request<{ error: { code: string } }>(
      'GET',
      `/wallets/${newId()}`,
    );
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('a provider can only submit and read its own transactions', async () => {
    const providerA = await token({ providerId: 'provider-a' });
    const providerB = await token({ providerId: 'provider-b' });
    const wallet = await walletAs(providerA);
    const { key, payload } = ApiClient.transaction({
      providerId: 'provider-a',
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const accepted = await client(providerA).request<{ transactionId: string }>(
      'POST',
      '/wagering/transactions',
      payload,
      { 'Idempotency-Key': key },
    );
    expect(accepted.status).toBe(201);

    // Provider B presenting provider A's payload is refused before any processing.
    const impersonation = await client(providerB).request<{ error: { code: string } }>(
      'POST',
      '/wagering/transactions',
      { ...payload, externalTransactionId: `tx-${newId()}` },
      { 'Idempotency-Key': `provider-a:${newId()}` },
    );
    expect(impersonation.status).toBe(403);
    expect(impersonation.body.error.code).toBe('PROVIDER_MISMATCH');
    expect(await db.walletState(wallet.id)).toMatchObject({ balance: '90.00', debits: 1 });

    const ownLookup = await client(providerA).request(
      'GET',
      `/wagering/transactions/${accepted.body.transactionId}`,
    );
    expect(ownLookup.status).toBe(200);
    const foreignLookup = await client(providerB).request(
      'GET',
      `/wagering/transactions/${accepted.body.transactionId}`,
    );
    expect(foreignLookup.status).toBe(404);
    const foreignPath = await client(providerB).request(
      'GET',
      `/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`,
    );
    expect(foreignPath.status).toBe(403);
  });
});
