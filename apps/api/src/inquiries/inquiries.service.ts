import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { createHash } from 'node:crypto';
import type {
  CreateInquiryRequest,
  InquiryReceipt,
  OwnerInquiriesResponse,
  OwnerInquiry,
  UpdateInquiryRequest
} from '@viedom/contracts';
import { AuthStore, duplicate } from '../auth/auth.store.js';
import { buildPublicEligibilityPipeline } from '../search/public-listings.pipeline.js';
import { Inquiry } from './inquiries.entities.js';
import { OwnerWrites } from '../database/owner-writes.js';
import type { InquiriesQuery } from './inquiries.dto.js';

type InquiryRecord = Omit<Inquiry, 'toJSON'>;
interface EligibleListing {
  _id: ObjectId;
  publisherId: ObjectId;
  title: string;
  version: number;
  updatedAt: Date;
  publisher: { _id: ObjectId; version: number };
  property: { _id: ObjectId; version: number; updatedAt: Date };
  gallery: { _id: ObjectId; version: number; updatedAt: Date };
  assets: { _id: ObjectId; updatedAt: Date }[];
}

export function ownerInquiry(row: InquiryRecord): OwnerInquiry {
  return {
    id: row._id.toHexString(),
    listingId: row.listingId.toHexString(),
    listingTitle: row.listingTitle,
    name: row.name,
    email: row.email,
    phone: row.phone,
    message: row.message,
    status: row.status,
    createdAt: row.createdAt.toISOString()
  };
}

export function decodeInquiryCursor(value: string, ownerId: ObjectId) {
  try {
    if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const text = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(text).toString('base64url') !== value) throw new Error();
    const data: unknown = JSON.parse(text);
    if (
      !Array.isArray(data) ||
      data.length !== 3 ||
      typeof data[0] !== 'string' ||
      typeof data[1] !== 'string' ||
      !/^[a-f0-9]{24}$/.test(data[1]) ||
      data[2] !== ownerId.toHexString()
    )
      throw new Error();
    const createdAt = new Date(data[0]);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== data[0])
      throw new Error();
    return { createdAt, id: new ObjectId(data[1]) };
  } catch {
    throw new BadRequestException('Invalid inquiry cursor.');
  }
}

@Injectable()
export class InquiriesService {
  constructor(
    private readonly orm: MikroORM,
    private readonly rates: AuthStore,
    private readonly writes: OwnerWrites
  ) {}

  private get db() {
    return this.orm.em.getConnection().getDb();
  }
  private get records() {
    return this.db.collection<InquiryRecord>('inquiries');
  }

  async submit(
    listingId: string,
    input: CreateInquiryRequest,
    ip: string,
    senderId: string | null
  ): Promise<InquiryReceipt> {
    if (!/^[a-f0-9]{24}$/.test(listingId)) throw new NotFoundException();
    await this.rates.limit('inquiry-ip', ip, 10, 600);
    await this.rates.limit('inquiry-email', input.email, 5, 3600);
    await this.rates.limit('inquiry-listing-ip', `${listingId}:${ip}`, 3, 600);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([listingId, input.email, input.message]))
      .digest('hex');
    const transaction = this.orm.em.getConnection().getClient().startSession();
    try {
      return await transaction.withTransaction(
        async () => {
          const now = new Date();
          const options = { session: transaction };
          const rows = await this.db
            .collection('listings')
            .aggregate<EligibleListing>(
              [
                ...buildPublicEligibilityPipeline({ _id: new ObjectId(listingId) }, now),
                { $limit: 1 },
                {
                  $project: {
                    _id: 1,
                    publisherId: 1,
                    title: 1,
                    version: 1,
                    updatedAt: 1,
                    publisher: { _id: '$publisher._id', version: '$publisher.version' },
                    property: {
                      _id: '$property._id',
                      version: '$property.version',
                      updatedAt: '$property.updatedAt'
                    },
                    gallery: {
                      _id: '$gallery._id',
                      version: '$gallery.version',
                      updatedAt: '$gallery.updatedAt'
                    },
                    assets: {
                      $map: {
                        input: '$assets',
                        as: 'asset',
                        in: { _id: '$$asset._id', updatedAt: '$$asset.updatedAt' }
                      }
                    }
                  }
                }
              ],
              { ...options, maxTimeMS: 2000, allowDiskUse: false }
            )
            .toArray();
          const listing = rows[0];
          if (!listing) throw new NotFoundException();
          if (listing.publisher.version >= Number.MAX_SAFE_INTEGER) throw new ConflictException();
          const publisher = await this.db.collection('users').updateOne(
            {
              _id: listing.publisherId,
              version: listing.publisher.version,
              status: 'active',
              deletedAt: null
            },
            { $inc: { version: 1 }, $set: { updatedAt: now } },
            options
          );
          if (publisher.modifiedCount !== 1) throw new ConflictException();
          for (const [collection, record] of [
            ['listings', listing],
            ['properties', listing.property],
            ['media_galleries', listing.gallery]
          ] as const) {
            const updatedAt = new Date(Math.max(now.getTime(), record.updatedAt.getTime() + 1));
            const changed = await this.db
              .collection(collection)
              .updateOne(
                { _id: record._id, version: record.version },
                { $set: { updatedAt } },
                options
              );
            if (changed.modifiedCount !== 1) throw new ConflictException();
          }
          for (const asset of listing.assets) {
            const updatedAt = new Date(Math.max(now.getTime(), asset.updatedAt.getTime() + 1));
            const changed = await this.db
              .collection('media_assets')
              .updateOne({ _id: asset._id, state: 'ready' }, { $set: { updatedAt } }, options);
            if (changed.modifiedCount !== 1) throw new ConflictException();
          }
          if (senderId) {
            const sender = await this.db
              .collection('users')
              .findOne({ _id: new ObjectId(senderId), status: 'active', deletedAt: null }, options);
            if (!sender) throw new ForbiddenException();
            if (!sender._id.equals(listing.publisherId)) {
              if (sender.version >= Number.MAX_SAFE_INTEGER) throw new ConflictException();
              const fenced = await this.db
                .collection('users')
                .updateOne(
                  { _id: sender._id, version: sender.version, status: 'active', deletedAt: null },
                  { $inc: { version: 1 }, $set: { updatedAt: now } },
                  options
                );
              if (fenced.modifiedCount !== 1) throw new ConflictException();
            }
          }
          const record = Object.assign(new Inquiry(), {
            listingId: listing._id,
            publisherId: listing.publisherId,
            senderId: senderId ? new ObjectId(senderId) : null,
            listingTitle: listing.title,
            name: input.name,
            email: input.email,
            phone: input.phone ?? null,
            message: input.message,
            createdAt: now,
            updatedAt: now
          });
          await this.rates.limit('inquiry-duplicate', fingerprint, 1, 600, transaction);
          await this.records.insertOne({ ...record }, options);
          return { id: record._id.toHexString() };
        },
        { timeoutMS: 5000 }
      );
    } catch (error) {
      if (duplicate(error)) throw new HttpException({ retryAfter: 600 }, 429);
      throw error;
    } finally {
      await transaction.endSession();
    }
  }

  async list(ownerId: ObjectId, query: InquiriesQuery): Promise<OwnerInquiriesResponse> {
    if (
      !(await this.db
        .collection('users')
        .findOne({ _id: ownerId, status: 'active', deletedAt: null }, { projection: { _id: 1 } }))
    )
      throw new ForbiddenException();
    const cursor = query.cursor ? decodeInquiryCursor(query.cursor, ownerId) : null;
    const rows = await this.records
      .find(
        {
          publisherId: ownerId,
          ...(cursor
            ? {
                $or: [
                  { createdAt: { $lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }
                ]
              }
            : {})
        },
        { sort: { createdAt: -1, _id: -1 }, limit: query.limit + 1 }
      )
      .toArray();
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map(ownerInquiry),
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify([
                last.createdAt.toISOString(),
                last._id.toHexString(),
                ownerId.toHexString()
              ])
            ).toString('base64url')
          : null
    };
  }

  async update(
    ownerId: ObjectId,
    id: ObjectId,
    input: UpdateInquiryRequest
  ): Promise<OwnerInquiry> {
    return this.writes.run(ownerId, async (em) => {
      const row = await em.findOne(Inquiry, { _id: id, publisherId: ownerId });
      if (!row) throw new NotFoundException();
      await em.nativeUpdate(
        Inquiry,
        { _id: id, publisherId: ownerId },
        { status: input.status, updatedAt: new Date() }
      );
      return ownerInquiry({ ...row, status: input.status });
    });
  }
}
