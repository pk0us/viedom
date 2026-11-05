import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { AuthHttp, noStore } from './auth.http.js';
import { AuthStore } from './auth.store.js';
import type { GoogleIdentity } from './auth.store.js';
import { LoginDto, RegisterDto, EmptyDto } from './auth.dto.js';
import { GoogleCallbackGuard, GoogleFlow } from './google.auth.js';
import { JwtAuthGuard } from './auth.guards.js';
import type { AuthRequest } from './auth.guards.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly http: AuthHttp,
    private readonly store: AuthStore,
    private readonly google: GoogleFlow
  ) {}
  @Get('csrf')
  csrf(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    noStore(response);
    return this.http.bootstrap(request, response);
  }
  @Post('register')
  async register(
    @Body() body: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    noStore(response);
    await this.http.check(request, false);
    await this.store.limit('credentials-ip', request.ip ?? '', 30, 900);
    await this.store.limit('credentials-email', body.email, 10, 900);
    const session = await this.auth.register(body);
    const result = await this.auth.response(session);
    this.http.writeRefresh(response, session.refreshToken, session.expiresAt);
    return result;
  }
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    noStore(response);
    await this.http.check(request, false);
    await this.store.limit('credentials-ip', request.ip ?? '', 30, 900);
    await this.store.limit('credentials-email', body.email, 10, 900);
    const session = await this.auth.login(body);
    const result = await this.auth.response(session);
    this.http.writeRefresh(response, session.refreshToken, session.expiresAt);
    return result;
  }
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() _body: EmptyDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    noStore(response);
    await this.http.check(request, true);
    await this.store.limit('refresh', request.ip ?? '', 60, 60);
    try {
      const session = await this.store.rotate(this.http.refreshCookie(request));
      const result = await this.auth.response(session);
      this.http.writeRefresh(response, session.refreshToken, session.expiresAt);
      return result;
    } catch (error) {
      this.http.clearRefresh(response);
      throw error;
    }
  }
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body() _body: EmptyDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    noStore(response);
    await this.http.check(request, true);
    await this.store.limit('logout', request.ip ?? '', 60, 60);
    await this.store.revoke(this.http.refreshCookie(request));
    this.http.clearRefresh(response);
  }
  @Post('google/start')
  @HttpCode(200)
  googleStart(
    @Body() _body: EmptyDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    noStore(response);
    return this.google.start(request, response);
  }
  @Get('google/callback')
  @UseGuards(GoogleCallbackGuard)
  async googleCallback(
    @Req() request: Request & { user: GoogleIdentity },
    @Res() response: Response
  ) {
    noStore(response);
    const session = await this.store.create(
      { google: request.user },
      this.http.config.auth.refreshTtl
    );
    this.http.writeRefresh(response, session.refreshToken, session.expiresAt);
    // No credentials in URL or HTML. Phase 07 bootstraps CSRF then refreshes.
    response.redirect(303, `${this.http.config.webOrigin}/auth/callback`);
  }
}
@Controller('me')
export class MeController {
  @Get()
  @UseGuards(JwtAuthGuard)
  me(@Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) {
    noStore(response);
    // Passport already attached an explicit safe transport projection.
    return request.user;
  }
}
