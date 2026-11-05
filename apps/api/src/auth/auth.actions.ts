import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/mongodb';
import { AuthStore, active, duplicate } from './auth.store.js';
import type { StoredUser } from './auth.store.js';
import { digest, Passwords, randomToken } from './auth.crypto.js';
import { AuthMail } from './auth.mail.js';
import type { ActionPurpose, DeliveryRecord } from './auth.schema.js';

const accountHash = (user: StoredUser) => digest(`${user.email}:${user.passwordHash ?? ''}`);
const eligible = (user: StoredUser | null, purpose: ActionPurpose): user is StoredUser =>
  active(user) && (purpose === 'verify-email' ? !user.emailVerifiedAt : Boolean(user.passwordHash));
export const emailAcknowledgement = {
  message: 'If the account is eligible, an email will be sent. Please check your inbox.'
};

@Injectable()
export class AuthActions implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthActions.name);
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | undefined;
  constructor(
    private readonly store: AuthStore,
    private readonly orm: MikroORM,
    private readonly mail: AuthMail,
    private readonly passwords: Passwords
  ) {}
  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.dispatch().catch(() => this.logger.warn('Authentication mail queue unavailable.'));
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }
  async request(email: string, purpose: ActionPurpose): Promise<void> {
    const user = await this.store.credentials(email);
    if (!eligible(user, purpose)) return;
    const now = new Date();
    const _id = `${user._id.toHexString()}:${purpose}`;
    await this.store.deliveries.deleteOne({
      _id,
      $or: [{ expiresAt: { $lte: now } }, { attempts: 5, leaseUntil: { $lte: now } }]
    });
    // Bounded one-job-per-account/purpose, no email, token or password in the queue.
    try {
      await this.store.deliveries.updateOne(
        { _id },
        {
          $setOnInsert: {
            userId: user._id,
            purpose,
            availableAt: now,
            leaseUntil: new Date(0),
            attempts: 0,
            expiresAt: new Date(now.getTime() + 3600_000)
          }
        },
        { upsert: true }
      );
    } catch (error) {
      if (!duplicate(error)) throw error;
    }
  }
  dispatch(): Promise<void> {
    return (this.running ??= this.drain().finally(() => {
      this.running = undefined;
    }));
  }
  private async drain(): Promise<void> {
    // Bounded batch; multiple API instances coordinate using expiring DB leases.
    for (let index = 0; index < 5; index++) {
      const now = new Date();
      const leaseUntil = new Date(now.getTime() + 60_000);
      const job = await this.store.deliveries.findOneAndUpdate(
        {
          availableAt: { $lte: now },
          leaseUntil: { $lte: now },
          expiresAt: { $gt: now },
          attempts: { $lt: 5 }
        },
        { $set: { leaseUntil }, $inc: { attempts: 1 } },
        { returnDocument: 'after', sort: { availableAt: 1 } }
      );
      if (!job) return;
      try {
        const delivery = await this.issue(job);
        if (delivery) await this.mail.send(delivery.email, job.purpose, delivery.token);
        await this.store.deliveries.deleteOne({ _id: job._id, leaseUntil });
      } catch {
        // Never log SMTP errors: they can contain recipient addresses or message content.
        this.logger.warn('Authentication email delivery failed; bounded retry scheduled.');
        await this.store.deliveries.updateOne(
          { _id: job._id, leaseUntil },
          {
            $set: {
              availableAt: new Date(Date.now() + 30_000 * 2 ** (job.attempts - 1)),
              leaseUntil: new Date(0)
            }
          }
        );
      }
    }
  }
  private async issue(job: DeliveryRecord) {
    const token = randomToken();
    const session = this.orm.em.getConnection().getClient().startSession();
    try {
      return await session.withTransaction(
        async () => {
          const options = { session };
          const now = new Date();
          // Reset/confirmation cancels queued work. A stale worker must not mint a
          // fresh token after that cancellation; this write serializes both paths.
          const claimed = await this.store.deliveries.updateOne(
            {
              _id: job._id,
              expiresAt: { $gt: now },
              leaseUntil: { $eq: job.leaseUntil, $gt: now }
            },
            { $set: { availableAt: new Date(now.getTime() + 1) } },
            options
          );
          if (claimed.matchedCount !== 1) return null;
          const user = await this.store.users.findOne({ _id: job.userId }, options);
          if (!eligible(user, job.purpose)) return null;
          // Fence against reset, login, suspension and other account mutations.
          const fenced = await this.store.users.updateOne(
            { _id: user._id, version: user.version },
            { $inc: { version: 1 }, $set: { updatedAt: now } },
            options
          );
          if (fenced.modifiedCount !== 1) throw new BadRequestException();
          await this.store.actions.deleteMany({ userId: user._id, purpose: job.purpose }, options);
          await this.store.actions.insertOne(
            {
              _id: digest(`${job.purpose}:${token}`),
              userId: user._id,
              purpose: job.purpose,
              accountHash: accountHash(user),
              expiresAt: new Date(
                now.getTime() + (job.purpose === 'verify-email' ? 86400_000 : 1800_000)
              )
            },
            options
          );
          return { email: user.email, token };
        },
        { timeoutMS: 5000 }
      );
    } finally {
      await session.endSession();
    }
  }
  async confirm(token: string, purpose: ActionPurpose, password?: string): Promise<void> {
    const _id = digest(`${purpose}:${token}`);
    // Reject bogus tokens before allocating expensive scrypt work.
    if (!(await this.store.actions.findOne({ _id, purpose, expiresAt: { $gt: new Date() } })))
      throw new BadRequestException();
    const passwordHash =
      purpose === 'reset-password' && password !== undefined
        ? await this.passwords.hash(password)
        : undefined;
    const session = this.orm.em.getConnection().getClient().startSession();
    try {
      await session.withTransaction(
        async () => {
          const options = { session };
          const now = new Date();
          const action = await this.store.actions.findOne(
            { _id, purpose, expiresAt: { $gt: now } },
            options
          );
          const user = action
            ? await this.store.users.findOne({ _id: action.userId }, options)
            : null;
          if (!action || !eligible(user, purpose) || action.accountHash !== accountHash(user))
            throw new BadRequestException();
          if (purpose === 'reset-password' && !passwordHash) throw new BadRequestException();
          const fenced = await this.store.users.updateOne(
            { _id: user._id, version: user.version },
            {
              $set: {
                updatedAt: now,
                ...(purpose === 'verify-email'
                  ? { emailVerifiedAt: now }
                  : { passwordHash: passwordHash! })
              },
              $inc: { version: 1 }
            },
            options
          );
          if (fenced.modifiedCount !== 1) throw new BadRequestException();
          if (purpose === 'reset-password') {
            await this.store.sessions.updateMany(
              { userId: user._id, revokedAt: null },
              { $set: { revokedAt: now } },
              options
            );
            await this.store.actions.deleteMany({ userId: user._id }, options);
            await this.store.deliveries.deleteMany({ userId: user._id }, options);
          } else {
            await this.store.actions.deleteOne({ _id }, options);
            await this.store.deliveries.deleteOne(
              { _id: `${user._id.toHexString()}:${purpose}` },
              options
            );
          }
        },
        { timeoutMS: 5000 }
      );
    } finally {
      await session.endSession();
    }
  }
}
