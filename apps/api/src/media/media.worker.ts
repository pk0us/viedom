import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/mongodb';
import { randomUUID } from 'node:crypto';
import { MediaAsset } from './media.entities.js';
import { MediaService, cleanupTime } from './media.service.js';
import {
  ImageProcessor,
  InvalidImage,
  MAX_IMAGE_BYTES,
  MAX_PROCESSING_ATTEMPTS,
  PROCESSING_LEASE_MS
} from './image-processor.js';
import { MediaStorage } from './storage.js';

@Injectable()
export class MediaWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaWorker.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | null = null;

  constructor(
    private readonly orm: MikroORM,
    private readonly media: MediaService,
    private readonly storage: MediaStorage,
    private readonly processor: ImageProcessor
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.dispatch().catch(() => this.logger.warn('Media processing queue unavailable.'));
    }, 2000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async onModuleDestroy(): Promise<void> {
    this.stop();
    await this.running?.catch(() => undefined);
  }

  dispatch(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        await this.processOne();
        await this.cleanup();
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async processOne(): Promise<void> {
    const em = this.orm.em.fork();
    const now = new Date();
    const asset = await em.findOne(
      MediaAsset,
      {
        $or: [
          { state: 'queued', availableAt: { $lte: now } },
          { state: 'processing', leaseUntil: { $lte: now } }
        ]
      },
      { orderBy: { availableAt: 'ASC', _id: 'ASC' } }
    );
    if (!asset) return;
    const token = randomUUID();
    const exhausted = asset.attempts >= MAX_PROCESSING_ATTEMPTS;
    const largeKey = `processed/${asset._id.toHexString()}/${token}/large.webp`;
    const thumbnailKey = `processed/${asset._id.toHexString()}/${token}/thumbnail.webp`;
    const leaseUntil = new Date(Date.now() + PROCESSING_LEASE_MS);
    const changed = await em.nativeUpdate(
      MediaAsset,
      {
        _id: asset._id,
        state: asset.state,
        leaseToken: asset.leaseToken,
        attempts: asset.attempts,
        ...(asset.state === 'processing' ? { leaseUntil: { $lte: now } } : {})
      },
      {
        state: 'processing',
        leaseToken: token,
        leaseUntil,
        attempts: exhausted ? asset.attempts : asset.attempts + 1,
        processingKeys: exhausted
          ? asset.processingKeys
          : [...asset.processingKeys, largeKey, thumbnailKey],
        updatedAt: new Date()
      }
    );
    if (changed !== 1) return;
    Object.assign(asset, {
      state: 'processing',
      leaseToken: token,
      leaseUntil,
      attempts: exhausted ? asset.attempts : asset.attempts + 1
    });
    if (await this.media.cancelUnavailable(asset)) return;
    if (exhausted) {
      await this.media.finish(asset._id, token, { errorCode: 'processing_failed' });
      return;
    }
    let outputAttempted = false;
    try {
      const head = await this.storage.head(asset.originalKey);
      if (
        head.bytes !== asset.expectedBytes ||
        head.bytes > MAX_IMAGE_BYTES ||
        head.contentType !== asset.contentType
      )
        throw new InvalidImage();
      const body = await this.storage.read(asset.originalKey, MAX_IMAGE_BYTES);
      if (body.length !== asset.expectedBytes) throw new InvalidImage();
      const image = await this.processor.process(body, asset.contentType);
      if (!(await this.current(asset, token))) return;
      outputAttempted = true;
      await this.storage.write(largeKey, image.large.data, 'image/webp');
      if (!(await this.current(asset, token))) return;
      await this.storage.write(thumbnailKey, image.thumbnail.data, 'image/webp');
      await this.media.finish(asset._id, token, {
        variants: {
          large: {
            key: largeKey,
            bytes: image.large.data.length,
            width: image.large.width,
            height: image.large.height
          },
          thumbnail: {
            key: thumbnailKey,
            bytes: image.thumbnail.data.length,
            width: image.thumbnail.width,
            height: image.thumbnail.height
          }
        }
      });
    } catch (error) {
      if (error instanceof InvalidImage || asset.attempts >= MAX_PROCESSING_ATTEMPTS) {
        await this.media.finish(asset._id, token, {
          errorCode: error instanceof InvalidImage ? 'invalid_image' : 'processing_failed'
        });
      } else {
        await this.orm.em.fork().nativeUpdate(
          MediaAsset,
          {
            _id: asset._id,
            state: 'processing',
            leaseToken: token
          },
          {
            state: 'queued',
            leaseToken: null,
            leaseUntil: null,
            availableAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** asset.attempts)),
            updatedAt: new Date()
          }
        );
      }
    } finally {
      if (outputAttempted) await this.scheduleCleanup(asset);
    }
  }

  private async scheduleCleanup(snapshot: MediaAsset): Promise<void> {
    const em = this.orm.em.fork();
    const asset = await em.findOne(MediaAsset, {
      _id: snapshot._id,
      state: { $in: ['ready', 'failed', 'deleted'] }
    });
    if (!asset) return;
    await em.nativeUpdate(
      MediaAsset,
      {
        _id: asset._id,
        state: asset.state,
        cleanupAt: asset.cleanupAt
      },
      { cleanupAt: cleanupTime(asset), cleanedAt: null }
    );
  }

  private current(asset: MediaAsset, token: string): Promise<MediaAsset | null> {
    return this.orm.em.fork().findOne(MediaAsset, {
      _id: asset._id,
      state: 'processing',
      leaseToken: token,
      leaseUntil: { $gt: new Date() }
    });
  }

  async cleanup(): Promise<void> {
    const em = this.orm.em.fork();
    const expired = await em.find(
      MediaAsset,
      {
        state: 'awaiting_upload',
        uploadExpiresAt: { $lte: new Date() }
      },
      { limit: 20, orderBy: { uploadExpiresAt: 'ASC' } }
    );
    for (const asset of expired) await this.media.expire(asset);
    const terminal = await em.find(
      MediaAsset,
      {
        state: { $in: ['ready', 'failed', 'deleted'] },
        cleanedAt: null,
        cleanupAt: { $ne: null, $lte: new Date() }
      },
      { limit: 20, orderBy: { cleanupAt: 'ASC' }, refresh: true }
    );
    for (const asset of terminal) {
      const keep = new Set(
        asset.state === 'ready' && asset.variants
          ? [asset.variants.large.key, asset.variants.thumbnail.key]
          : []
      );
      try {
        for (const key of [asset.originalKey, ...asset.processingKeys])
          if (!keep.has(key)) await this.storage.remove(key);
        await this.orm.em.fork().nativeUpdate(
          MediaAsset,
          {
            _id: asset._id,
            state: asset.state,
            cleanupAt: asset.cleanupAt,
            leaseToken: asset.leaseToken,
            cleanedAt: null
          },
          { cleanedAt: new Date() }
        );
      } catch {
        await this.orm.em.fork().nativeUpdate(
          MediaAsset,
          {
            _id: asset._id,
            cleanupAt: asset.cleanupAt,
            cleanedAt: null
          },
          { cleanupAt: new Date(Date.now() + 60_000) }
        );
      }
    }
  }
}
