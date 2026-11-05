import {
  BadRequestException,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { AuthGuard, PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-google-oauth20';
import type { Profile, StrategyOptions } from 'passport-google-oauth20';
import type { Request, Response } from 'express';
import { Configuration } from '../configuration.js';
import { AuthStore } from './auth.store.js';
import type { GoogleIdentity } from './auth.store.js';
import { AuthHttp, cookie } from './auth.http.js';
import { digest, randomToken } from './auth.crypto.js';
import { normalizeEmail } from '../database/domain.js';
import { createHash } from 'node:crypto';

/** This receives only Google's server-fetched userinfo, never client-supplied profile JSON. */
export function googleIdentity(profile: Profile): GoogleIdentity {
  const verified = profile.emails?.find((entry) => entry.verified === true);
  if (profile.provider !== 'google' || !/^[A-Za-z0-9_-]{1,255}$/.test(profile.id) || !verified)
    throw new UnauthorizedException();
  let email: string;
  try {
    email = normalizeEmail(verified.value);
  } catch {
    throw new UnauthorizedException();
  }
  const name = (value: string | undefined, fallback: string) =>
    value?.trim().slice(0, 100) || fallback;
  return {
    subject: profile.id,
    email,
    firstName: name(profile.name?.givenName, 'Google'),
    lastName: name(profile.name?.familyName, 'User')
  };
}

@Injectable()
export class GoogleFlow {
  constructor(
    private readonly configuration: Configuration,
    private readonly store: AuthStore,
    private readonly http: AuthHttp
  ) {}
  async start(request: Request, response: Response) {
    const { auth } = this.configuration.values;
    if (!auth.googleClientId) throw new ServiceUnavailableException();
    await this.http.check(request, false);
    await this.store.limit('google-start', request.ip ?? '', 20, 900);
    const state = randomToken();
    const browser = randomToken();
    const verifier = randomToken();
    await this.store.states.insertOne({
      _id: digest(state),
      browserHash: digest(browser),
      verifier,
      expiresAt: new Date(Date.now() + 600_000)
    });
    response.cookie(this.http.oauthName, browser, {
      ...this.http.options('/api/auth/google/callback'),
      maxAge: 600_000
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: auth.googleClientId,
      redirect_uri: auth.googleCallbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      access_type: 'online'
    }).toString();
    return { authorizationUrl: url.href };
  }
  async consume(request: Request, state: unknown): Promise<string | false> {
    const browser = cookie(request, this.http.oauthName);
    if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browser) return false;
    const flow = await this.store.states.findOneAndDelete({
      _id: digest(state),
      browserHash: digest(browser),
      expiresAt: { $gt: new Date() }
    });
    return flow?.verifier ?? false;
  }
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configuration: Configuration, flow: GoogleFlow) {
    // passport-oauth2's runtime PKCE callback returns the verifier as `ok`;
    // DefinitelyTyped still declares the older boolean-only StateStore contract.
    const stateStore = {
      store: (_request: Request, done: (error: Error) => void) =>
        done(new Error('Use the Google start endpoint.')),
      verify: (
        request: Request,
        state: string,
        done: (error: Error | null, verifier?: string | false) => void
      ) => {
        flow.consume(request, state).then(
          (verifier) => done(null, verifier),
          () => done(new Error('OAuth state unavailable.'))
        );
      }
    } as unknown as StrategyOptions['store'];
    super({
      clientID: configuration.values.auth.googleClientId || 'disabled',
      clientSecret: configuration.values.auth.googleClientSecret || 'disabled',
      callbackURL: configuration.values.auth.googleCallbackUrl,
      scope: ['openid', 'email', 'profile'],
      state: true,
      pkce: true,
      store: stateStore
    });
  }
  validate(_accessToken: string, _refreshToken: string, profile: Profile): GoogleIdentity {
    return googleIdentity(profile);
  }
}

@Injectable()
export class GoogleCallbackGuard extends AuthGuard('google') {
  constructor(
    private readonly configuration: Configuration,
    private readonly flow: GoogleFlow,
    private readonly http: AuthHttp,
    private readonly store: AuthStore
  ) {
    super();
  }
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.configuration.values.auth.googleClientId) throw new ServiceUnavailableException();
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    await this.store.limit('google-callback', request.ip ?? '', 60, 900);
    // Clear on every outcome, including consent denial and failed exchange.
    response.clearCookie(this.http.oauthName, this.http.options('/api/auth/google/callback'));
    if (request.query['error']) {
      await this.flow.consume(request, request.query['state']);
      throw new UnauthorizedException();
    }
    if (
      typeof request.query['code'] !== 'string' ||
      request.query['code'].length > 4096 ||
      typeof request.query['state'] !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(request.query['state'])
    )
      throw new BadRequestException();
    return (await super.canActivate(context)) as boolean;
  }
  override handleRequest<TUser>(error: unknown, user: TUser | false): TUser {
    if (error || !user) throw new UnauthorizedException();
    return user;
  }
}
