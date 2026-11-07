import { EntitySchema } from '@mikro-orm/core';
import { ObjectId } from '@mikro-orm/mongodb';

export class ModerationDecision {
  _id = new ObjectId();
  listingId!: ObjectId;
  publisherId!: ObjectId;
  reviewerId!: ObjectId;
  reviewedVersion!: number;
  resultVersion!: number;
  decision!: 'approved' | 'rejected';
  reason: string | null = null;
  createdAt = new Date();

  toJSON(): never {
    throw new Error('Moderation records require an explicit response mapper.');
  }
}

export const ModerationDecisionSchema = new EntitySchema<ModerationDecision>({
  class: ModerationDecision,
  tableName: 'moderation_decisions',
  properties: {
    _id: { type: 'ObjectId', primary: true, hidden: true },
    listingId: { type: 'ObjectId', hidden: true },
    publisherId: { type: 'ObjectId', hidden: true },
    reviewerId: { type: 'ObjectId', hidden: true },
    reviewedVersion: { type: 'number' },
    resultVersion: { type: 'number' },
    decision: { type: 'string' },
    reason: { type: 'string', nullable: true, hidden: true },
    createdAt: { type: 'Date' }
  }
});

export const moderationValidators = {
  moderation_decisions: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'listingId',
        'publisherId',
        'reviewerId',
        'reviewedVersion',
        'resultVersion',
        'decision',
        'reason',
        'createdAt'
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        listingId: { bsonType: 'objectId' },
        publisherId: { bsonType: 'objectId' },
        reviewerId: { bsonType: 'objectId' },
        reviewedVersion: {
          bsonType: ['double', 'int', 'long'],
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER - 1,
          multipleOf: 1
        },
        resultVersion: {
          bsonType: ['double', 'int', 'long'],
          minimum: 2,
          maximum: Number.MAX_SAFE_INTEGER,
          multipleOf: 1
        },
        decision: { enum: ['approved', 'rejected'] },
        reason: { bsonType: ['string', 'null'], minLength: 1, maxLength: 2000 },
        createdAt: { bsonType: 'date' }
      },
      oneOf: [
        { properties: { decision: { enum: ['approved'] }, reason: { bsonType: 'null' } } },
        {
          properties: {
            decision: { enum: ['rejected'] },
            reason: { bsonType: 'string', minLength: 1, maxLength: 2000 }
          }
        }
      ]
    },
    $expr: {
      $and: [
        { $ne: ['$reviewerId', '$publisherId'] },
        { $eq: ['$resultVersion', { $add: ['$reviewedVersion', 1] }] }
      ]
    }
  }
};
