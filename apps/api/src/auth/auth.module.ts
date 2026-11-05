import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { Configuration } from '../configuration.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuthController, MeController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthStore } from './auth.store.js';
import { AuthActions } from './auth.actions.js';
import { AuthMail } from './auth.mail.js';
import { Passwords } from './auth.crypto.js';
import { AuthHttp, noStore } from './auth.http.js';
import { GoogleCallbackGuard, GoogleFlow, GoogleStrategy } from './google.auth.js';
import { JwtAuthGuard, JwtStrategy, RolesGuard, VerifiedEmailGuard } from './auth.guards.js';
import type { Request, Response, NextFunction } from 'express';

@Module({
  imports: [DatabaseModule, PassportModule.register({ session: false }), JwtModule.register({})],
  controllers: [AuthController, MeController],
  providers: [
    Configuration,
    AuthStore,
    AuthActions,
    AuthMail,
    Passwords,
    AuthHttp,
    AuthService,
    GoogleFlow,
    GoogleStrategy,
    GoogleCallbackGuard,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    VerifiedEmailGuard
  ],
  exports: [AuthStore, JwtAuthGuard, RolesGuard, VerifiedEmailGuard]
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((_request: Request, response: Response, next: NextFunction) => {
        noStore(response);
        next();
      })
      .forRoutes(AuthController, MeController);
  }
}
