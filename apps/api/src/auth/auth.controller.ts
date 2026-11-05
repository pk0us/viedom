import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { AuthHttp, noStore } from './auth.http.js';
import { AuthStore } from './auth.store.js';
import type { GoogleIdentity } from './auth.store.js';
import {
  LoginDto,
  RegisterDto,
  EmptyDto,
  EmailActionDto,
  ConfirmEmailDto,
  ResetPasswordDto
} from './auth.dto.js';
import { AuthActions, emailAcknowledgement } from './auth.actions.js';
import { GoogleCallbackGuard, GoogleFlow } from './google.auth.js';
import { JwtAuthGuard } from './auth.guards.js';
import type { AuthRequest } from './auth.guards.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly http: AuthHttp,
    private readonly store: AuthStore,
    private readonly google: GoogleFlow,
    private readonly actions: AuthActions
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
  private async actionLimits(request: Request, scope: string, email?: string) {
    await this.http.check(request, false);
    await this.store.limit(`${scope}-ip`, request.ip ?? '', 20, 900);
    // Silent per-email suppression preserves the generic response for targeted resends.
    if (email) {
      try {
        await this.store.limit(`${scope}-email`, email, 3, 900);
      } catch (error) {
        if (error instanceof HttpException && error.getStatus() === 429) return false;
        throw error;
      }
    }
    return true;
  }
  @Post('verification/request')
  @HttpCode(202)
  async verificationRequest(@Body() body: EmailActionDto, @Req() request: Request) {
    if (await this.actionLimits(request, 'verification-request', body.email))
      await this.actions.request(body.email, 'verify-email');
    return emailAcknowledgement;
  }
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(@Body() body: EmailActionDto, @Req() request: Request) {
    if (await this.actionLimits(request, 'recovery-request', body.email))
      await this.actions.request(body.email, 'reset-password');
    return emailAcknowledgement;
  }
  @Post('verification/confirm')
  @HttpCode(204)
  async verificationConfirm(@Body() body: ConfirmEmailDto, @Req() request: Request) {
    await this.actionLimits(request, 'verification-confirm');
    await this.actions.confirm(body.token, 'verify-email');
  }
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(@Body() body: ResetPasswordDto, @Req() request: Request) {
    await this.actionLimits(request, 'recovery-confirm');
    await this.actions.confirm(body.token, 'reset-password', body.password);
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
