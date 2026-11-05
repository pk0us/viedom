import { ObjectId } from '@mikro-orm/mongodb';

export interface SessionRecord {
  _id: ObjectId;
  userId: ObjectId;
  currentHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}
export interface RefreshRecord {
  _id: string;
  sessionId: ObjectId;
  expiresAt: Date;
}
export interface IdentityRecord {
  _id: ObjectId;
  provider: 'google';
  subject: string;
  userId: ObjectId;
}
export interface OAuthRecord {
  _id: string;
  browserHash: string;
  verifier: string;
  expiresAt: Date;
}
export interface RateRecord {
  _id: string;
  count: number;
  expiresAt: Date;
}

const id = { bsonType: 'objectId' };
const hash = { bsonType: 'string', pattern: '^[a-f0-9]{64}$' };
const date = { bsonType: 'date' };
const schema = (properties: Record<string, unknown>) => ({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties
  }
});
// Additive collections: existing users/fixtures require no privileged validator migration.
export const authValidators = {
  auth_sessions: schema({
    _id: id,
    userId: id,
    currentHash: hash,
    createdAt: date,
    expiresAt: date,
    revokedAt: { bsonType: ['date', 'null'] }
  }),
  auth_refresh_tokens: schema({ _id: hash, sessionId: id, expiresAt: date }),
  auth_identities: schema({
    _id: id,
    userId: id,
    provider: { enum: ['google'] },
    subject: { bsonType: 'string', minLength: 1, maxLength: 255 }
  }),
  auth_oauth_states: schema({
    _id: hash,
    browserHash: hash,
    verifier: { bsonType: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
    expiresAt: date
  }),
  auth_rate_limits: schema({
    _id: hash,
    count: { bsonType: ['int', 'long', 'double'], minimum: 1, multipleOf: 1 },
    expiresAt: date
  })
};
