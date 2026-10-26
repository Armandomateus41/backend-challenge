import { type Request } from 'express';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { AuthenticationError, TransientInfrastructureError } from '../../application/errors';
import { type ProviderAuthenticator, type ProviderIdentity } from '../../interface/http/auth';

export interface JwtAuthOptions {
  issuer: string;
  jwksUrl: string;
  audience: string | undefined;
  /** Claim that carries the provider id, set per client by the IdP. */
  providerClaim: string;
}

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Verifies OAuth2 client-credentials access tokens issued by an external IdP (Keycloak in the
 * local setup). Signature keys come from the IdP JWKS endpoint and are cached and refreshed by
 * `jose`; issuer, audience and expiry are enforced. No credentials are stored by this service.
 */
export class JwtProviderAuthenticator implements ProviderAuthenticator {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: JwtAuthOptions) {
    this.jwks = createRemoteJWKSet(new URL(options.jwksUrl), { timeoutDuration: 3000 });
  }

  async authenticate(request: Request): Promise<ProviderIdentity> {
    const header = request.header('authorization');
    const token = header ? BEARER.exec(header)?.[1] : undefined;
    if (!token) {
      throw new AuthenticationError('A bearer token is required');
    }
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        ...(this.options.audience ? { audience: this.options.audience } : {}),
        algorithms: ['RS256', 'PS256', 'ES256'],
      }));
    } catch (error) {
      if (error instanceof errors.JWKSTimeout || isNetworkError(error)) {
        throw new TransientInfrastructureError('Identity provider unavailable', 'unavailable', {
          cause: error,
        });
      }
      throw new AuthenticationError('Invalid or expired token', { cause: error });
    }
    const providerId = payload[this.options.providerClaim];
    if (typeof providerId !== 'string' || providerId.length === 0) {
      throw new AuthenticationError(`Token has no ${this.options.providerClaim} claim`);
    }
    return {
      providerId,
      subject: typeof payload.sub === 'string' ? payload.sub : undefined,
    };
  }
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof errors.JOSEError) {
    return false;
  }
  return error instanceof TypeError || (error as { code?: unknown })?.code === 'ECONNREFUSED';
}
