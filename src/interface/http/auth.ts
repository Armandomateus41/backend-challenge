import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';
import { ProviderMismatchError } from '../../application/errors';
import { enrichContext } from '../../observability/context';

export const IS_PUBLIC = 'isPublic';

/** Marks a route as reachable without authentication (health checks, metrics). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Identity of the game provider that authenticated the request. */
export interface ProviderIdentity {
  providerId: string;
  subject: string | undefined;
}

/**
 * Authenticates a request. Returns the provider identity, or `undefined` when authentication is
 * disabled. Throws AuthenticationError for missing or invalid credentials.
 */
export interface ProviderAuthenticator {
  authenticate(request: Request): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_AUTHENTICATOR = Symbol('PROVIDER_AUTHENTICATOR');

/** Used when AUTH_ENABLED is false: every request is anonymous and allowed. */
export class AllowAllProviderAuthenticator implements ProviderAuthenticator {
  authenticate(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

interface AuthenticatedRequest extends Request {
  providerIdentity?: ProviderIdentity;
}

export function providerIdentityOf(request: Request): ProviderIdentity | undefined {
  return (request as AuthenticatedRequest).providerIdentity;
}

/**
 * Rejects requests where the authenticated provider differs from the provider named by the
 * payload or path. No-op when authentication is disabled.
 */
export function assertProviderAccess(request: Request, providerId: string): void {
  const identity = providerIdentityOf(request);
  if (identity && identity.providerId !== providerId) {
    throw new ProviderMismatchError(identity.providerId, providerId);
  }
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PROVIDER_AUTHENTICATOR) private readonly authenticator: ProviderAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const identity = await this.authenticator.authenticate(request);
    if (identity) {
      (request as AuthenticatedRequest).providerIdentity = identity;
      enrichContext({ providerId: identity.providerId });
    }
    return true;
  }
}
