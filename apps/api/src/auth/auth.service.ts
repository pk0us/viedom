import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthResponse, CurrentUser } from '@viedom/contracts';
import { Configuration } from '../configuration.js';
import { normalizeEmail } from '../database/domain.js';
import { AuthStore, active } from './auth.store.js';
import type { StoredUser } from './auth.store.js';
import { Passwords } from './auth.crypto.js';
import { AuthHttp } from './auth.http.js';
import { LoginDto, RegisterDto } from './auth.dto.js';

export function currentUser(user: StoredUser): CurrentUser {
  return {
    id: user._id.toHexString(),
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    emailVerified: Boolean(user.emailVerifiedAt)
  };
}
@Injectable()
export class AuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly passwords: Passwords,
    private readonly jwt: JwtService,
    private readonly configuration: Configuration,
    private readonly http: AuthHttp
  ) {}
  async register(dto: RegisterDto) {
    // Keep runtime DTO and persisted normalized-email rules consistent.
    try {
      normalizeEmail(dto.email);
    } catch {
      throw new BadRequestException();
    }
    return this.store.create(
      { registration: dto, hash: await this.passwords.hash(dto.password) },
      this.configuration.values.auth.refreshTtl
    );
  }
  async login(dto: LoginDto) {
    const user = await this.store.credentials(dto.email);
    const valid = await this.passwords.verify(dto.password, user?.passwordHash ?? null);
    if (!valid || !active(user)) throw new UnauthorizedException();
    return this.store.create({ user }, this.configuration.values.auth.refreshTtl);
  }
  async response(result: Awaited<ReturnType<AuthStore['create']>>): Promise<AuthResponse> {
    const { auth } = this.configuration.values;
    const expiresIn = Math.min(
      auth.accessTtl,
      Math.floor((result.expiresAt.getTime() - Date.now()) / 1000)
    );
    if (expiresIn < 1) throw new UnauthorizedException();
    return {
      accessToken: await this.jwt.signAsync(
        { sub: result.user._id.toHexString(), sid: result.sessionId.toHexString() },
        {
          secret: auth.accessSecret,
          algorithm: 'HS256',
          issuer: 'viedom-api',
          audience: 'viedom-web',
          expiresIn
        }
      ),
      expiresIn,
      csrfToken: this.http.sessionCsrf(result.sessionId.toHexString()),
      user: currentUser(result.user)
    };
  }
}
