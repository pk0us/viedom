import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { User } from '../database/entities.js';
import { normalizeEmail } from '../database/domain.js';
import type {
  IdentityRecord,
  OAuthRecord,
  RateRecord,
  RefreshRecord,
  SessionRecord
} from './auth.schema.js';
import { digest, randomToken } from './auth.crypto.js';
import type { RegisterDto } from './auth.dto.js';

export interface GoogleIdentity {
  subject: string;
  email: string;
  firstName: string;
  lastName: string;
}
export type StoredUser = Omit<User, 'toJSON'>;
export const active = (user: StoredUser | null): user is StoredUser =>
  Boolean(user && user.status === 'active' && !user.deletedAt);
export const duplicate = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

/** Native atomic operations use MikroORM's owned Mongo client; no second pool. */
@Injectable()
export class AuthStore {
  constructor(private readonly orm: MikroORM) {}
  private get db() {
    return this.orm.em.getConnection().getDb();
  }
  get users() {
    return this.db.collection<StoredUser>('users');
  }
  get sessions() {
    return this.db.collection<SessionRecord>('auth_sessions');
  }
  get tokens() {
    return this.db.collection<RefreshRecord>('auth_refresh_tokens');
  }
  get identities() {
    return this.db.collection<IdentityRecord>('auth_identities');
  }
  get states() {
    return this.db.collection<OAuthRecord>('auth_oauth_states');
  }
  get rates() {
    return this.db.collection<RateRecord>('auth_rate_limits');
  }

  async limit(scope: string, key: string, maximum: number, seconds: number): Promise<void> {
    const bucket = Math.floor(Date.now() / (seconds * 1000));
    const _id = digest(`${scope}:${key}:${bucket}`);
    const update = () =>
      this.rates.findOneAndUpdate(
        { _id },
        {
          $inc: { count: 1 },
          $setOnInsert: { expiresAt: new Date((bucket + 2) * seconds * 1000) }
        },
        { upsert: true, returnDocument: 'after' }
      );
    let record;
    try {
      record = await update();
    } catch (error) {
      if (!duplicate(error)) throw error;
      record = await update();
    }
    if (!record || record.count > maximum)
      throw new HttpException(
        { retryAfter: Math.max(1, Math.ceil(((bucket + 1) * seconds * 1000 - Date.now()) / 1000)) },
        429
      );
  }

  async credentials(email: string): Promise<StoredUser | null> {
    return this.users.findOne({ email });
  }
  async current(userId: ObjectId, sessionId: ObjectId): Promise<StoredUser> {
    const session = await this.sessions.findOne({
      _id: sessionId,
      userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() }
    });
    const user = session ? await this.users.findOne({ _id: userId }) : null;
    if (!active(user)) throw new UnauthorizedException();
    return user;
  }
  async sessionFor(token: string) {
    const previous = await this.tokens.findOne({
      _id: digest(token),
      expiresAt: { $gt: new Date() }
    });
    return previous
      ? this.sessions.findOne({
          _id: previous.sessionId,
          revokedAt: null,
          expiresAt: { $gt: new Date() }
        })
      : null;
  }

  async create(
    input:
      | { registration: RegisterDto; hash: string }
      | { user: StoredUser }
      | { google: GoogleIdentity },
    ttl: number
  ) {
    const refreshToken = randomToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    const sessionId = new ObjectId();
    const transaction = this.orm.em.getConnection().getClient().startSession();
    try {
      return await transaction.withTransaction(
        async () => {
          const options = { session: transaction };
          let user: StoredUser | null;
          if ('registration' in input) {
            user = Object.assign(new User(), {
              email: normalizeEmail(input.registration.email),
              firstName: input.registration.firstName,
              lastName: input.registration.lastName,
              passwordHash: input.hash
            });
            await this.users.insertOne({ ...user }, options);
          } else if ('google' in input) {
            const identity = await this.identities.findOne(
              { provider: 'google', subject: input.google.subject },
              options
            );
            if (identity) {
              user = await this.users.findOne({ _id: identity.userId }, options);
            } else {
              // Matching email is not authorization to link an existing account.
              if (await this.users.findOne({ email: input.google.email }, options))
                throw new HttpException('Account conflict', 409);
              user = Object.assign(new User(), {
                email: normalizeEmail(input.google.email),
                firstName: input.google.firstName,
                lastName: input.google.lastName,
                emailVerifiedAt: now
              });
              await this.users.insertOne({ ...user }, options);
              await this.identities.insertOne(
                {
                  _id: new ObjectId(),
                  userId: user._id,
                  provider: 'google',
                  subject: input.google.subject
                },
                options
              );
            }
          } else {
            user = await this.users.findOne(
              { _id: input.user._id, passwordHash: input.user.passwordHash },
              options
            );
          }
          if (!active(user)) throw new UnauthorizedException();
          // Serialize session creation against current account/password changes.
          const fenced = await this.users.updateOne(
            { _id: user._id, version: user.version, status: 'active', deletedAt: null },
            { $inc: { version: 1 }, $set: { updatedAt: now } },
            options
          );
          if (fenced.modifiedCount !== 1) throw new UnauthorizedException();
          await this.sessions.insertOne(
            {
              _id: sessionId,
              userId: user._id,
              currentHash: digest(refreshToken),
              createdAt: now,
              expiresAt,
              revokedAt: null
            },
            options
          );
          await this.tokens.insertOne({ _id: digest(refreshToken), sessionId, expiresAt }, options);
          return { user, sessionId, refreshToken, expiresAt };
        },
        { timeoutMS: 5000 }
      );
    } catch (error) {
      if (duplicate(error)) throw new HttpException('Account conflict', 409);
      throw error;
    } finally {
      await transaction.endSession();
    }
  }

  async rotate(token: string) {
    const next = randomToken();
    const now = new Date();
    const transaction = this.orm.em.getConnection().getClient().startSession();
    try {
      const result = await transaction.withTransaction(
        async () => {
          const options = { session: transaction };
          const previous = await this.tokens.findOne(
            { _id: digest(token), expiresAt: { $gt: now } },
            options
          );
          const session = previous
            ? await this.sessions.findOne(
                { _id: previous.sessionId, revokedAt: null, expiresAt: { $gt: now } },
                options
              )
            : null;
          if (!session) return null;
          const user = await this.users.findOne({ _id: session.userId }, options);
          if (session.currentHash !== digest(token) || !active(user)) {
            await this.sessions.updateOne(
              { _id: session._id },
              { $set: { revokedAt: now } },
              options
            );
            return null; // Commit revocation before reporting failure.
          }
          await this.sessions.updateOne(
            { _id: session._id, currentHash: digest(token) },
            { $set: { currentHash: digest(next) } },
            options
          );
          await this.tokens.insertOne(
            { _id: digest(next), sessionId: session._id, expiresAt: session.expiresAt },
            options
          );
          return { user, sessionId: session._id, refreshToken: next, expiresAt: session.expiresAt };
        },
        { timeoutMS: 5000 }
      );
      if (!result) throw new UnauthorizedException();
      return result;
    } finally {
      await transaction.endSession();
    }
  }
  async revoke(token: string): Promise<void> {
    const previous = await this.tokens.findOne({ _id: digest(token) });
    if (previous)
      await this.sessions.updateOne(
        { _id: previous.sessionId },
        { $set: { revokedAt: new Date() } }
      );
  }
}
