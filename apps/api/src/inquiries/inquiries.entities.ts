import { EntitySchema } from '@mikro-orm/core';
import { ObjectId } from '@mikro-orm/mongodb';
import type { InquiryStatus } from '@viedom/contracts';

export class Inquiry {
  _id = new ObjectId();
  listingId!: ObjectId;
  publisherId!: ObjectId;
  senderId: ObjectId | null = null;
  listingTitle!: string;
  name!: string;
  email!: string;
  phone: string | null = null;
  message!: string;
  status: InquiryStatus = 'unread';
  createdAt = new Date();
  updatedAt = new Date();

  toJSON(): never {
    throw new Error('Inquiry records require an explicit response mapper.');
  }
}

export const InquirySchema = new EntitySchema<Inquiry>({
  class: Inquiry,
  tableName: 'inquiries',
  properties: {
    _id: { type: 'ObjectId', primary: true, hidden: true },
    listingId: { type: 'ObjectId', hidden: true },
    publisherId: { type: 'ObjectId', hidden: true },
    senderId: { type: 'ObjectId', nullable: true, hidden: true },
    listingTitle: { type: 'string', hidden: true },
    name: { type: 'string', hidden: true },
    email: { type: 'string', hidden: true },
    phone: { type: 'string', nullable: true, hidden: true },
    message: { type: 'string', hidden: true },
    status: { type: 'string', hidden: true },
    createdAt: { type: 'Date', hidden: true },
    updatedAt: { type: 'Date', hidden: true }
  }
});

const text = (minLength: number, maxLength: number) => ({
  bsonType: 'string',
  minLength,
  maxLength
});
export const inquiryValidators = {
  inquiries: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'listingId',
        'publisherId',
        'senderId',
        'listingTitle',
        'name',
        'email',
        'phone',
        'message',
        'status',
        'createdAt',
        'updatedAt'
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        listingId: { bsonType: 'objectId' },
        publisherId: { bsonType: 'objectId' },
        senderId: { bsonType: ['objectId', 'null'] },
        listingTitle: text(0, 160),
        name: text(1, 100),
        email: text(3, 254),
        phone: { bsonType: ['string', 'null'], minLength: 1, maxLength: 32 },
        message: text(10, 4000),
        status: { enum: ['unread', 'read', 'archived'] },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' }
      }
    }
  }
};
