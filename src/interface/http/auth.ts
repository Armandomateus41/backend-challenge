import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';

export const IS_PUBLIC = 'isPublic';

/** Marks a route as reachable without authentication (health checks, metrics). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Extension point for provider authentication. The production design (see ARCHITECTURE.md) is an
 * OIDC client-credentials token issued by an external IdP (e.g. Keycloak) per game provider,
 * verified against the IdP JWKS; the `providerId` claim must equal the providerId in the payload.
 */
export interface ProviderAuthenticator {
  authenticate(request: Request): Promise<boolean>;
}

export const PROVIDER_AUTHENTICATOR = Symbol('PROVIDER_AUTHENTICATOR');

/** Default implementation: authentication is out of scope for this challenge. */
export class AllowAllProviderAuthenticator implements ProviderAuthenticator {
  authenticate(): Promise<boolean> {
    return Promise.resolve(true);
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
    return this.authenticator.authenticate(context.switchToHttp().getRequest<Request>());
  }
}
