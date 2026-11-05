import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ObjectId } from '@mikro-orm/mongodb';
import { Configuration } from '../configuration.js';
import { AuthStore } from './auth.store.js';
import { currentUser } from './auth.service.js';
import type { CurrentUser } from '@viedom/contracts';
import type { Request } from 'express';

export type AuthRequest = Request & { user: CurrentUser };
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configuration: Configuration,
    private readonly store: AuthStore
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configuration.values.auth.accessSecret,
      algorithms: ['HS256'],
      issuer: 'viedom-api',
      audience: 'viedom-web',
      ignoreExpiration: false
    });
  }
  async validate(payload: unknown): Promise<CurrentUser> {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('sub' in payload) ||
      !('sid' in payload) ||
      !('exp' in payload) ||
      !('iat' in payload) ||
      typeof payload.exp !== 'number' ||
      typeof payload.iat !== 'number' ||
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      !/^[a-f0-9]{24}$/.test(payload.sub) ||
      !/^[a-f0-9]{24}$/.test(payload.sid)
    )
      throw new UnauthorizedException();
    return currentUser(
      await this.store.current(new ObjectId(payload.sub), new ObjectId(payload.sid))
    );
  }
}
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
const roleKey = 'viedom.roles';
export const Roles = (...roles: CurrentUser['role'][]) => SetMetadata(roleKey, roles);
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<CurrentUser['role'][]>(roleKey, [
      context.getHandler(),
      context.getClass()
    ]);
    const user = context.switchToHttp().getRequest<AuthRequest>().user;
    if (!user) throw new UnauthorizedException();
    if (roles && !roles.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}
@Injectable()
export class VerifiedEmailGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<AuthRequest>().user;
    if (!user) throw new UnauthorizedException();
    if (!user.emailVerified) throw new ForbiddenException();
    return true;
  }
}
