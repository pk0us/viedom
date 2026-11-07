import { EntitySchema } from '@mikro-orm/core';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { User } from './entities.js';
import { normalizeEmail } from './domain.js';

export class FirstAdminGrant {
  _id = 'first-admin';
  userId!: ObjectId;
  email!: string;
  createdAt = new Date();
}

export const FirstAdminGrantSchema = new EntitySchema<FirstAdminGrant>({
  class: FirstAdminGrant,
  tableName: 'admin_provisioning',
  properties: {
    _id: { type: 'string', primary: true, hidden: true },
    userId: { type: 'ObjectId', hidden: true },
    email: { type: 'string', hidden: true },
    createdAt: { type: 'Date', hidden: true }
  }
});

export const adminProvisioningValidators = {
  admin_provisioning: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['_id', 'userId', 'email', 'createdAt'],
      properties: {
        _id: { enum: ['first-admin'] },
        userId: { bsonType: 'objectId' },
        email: { bsonType: 'string', minLength: 3, maxLength: 254 },
        createdAt: { bsonType: 'date' }
      }
    }
  }
};

export async function provisionFirstAdmin(orm: MikroORM, id: string, email: string): Promise<void> {
  if (!/^[a-f0-9]{24}$/.test(id) || email !== normalizeEmail(email))
    throw new Error('Exact account identity required.');
  await orm.em.fork().transactional(async (em) => {
    const user = await em.findOne(User, {
      _id: new ObjectId(id),
      email,
      role: 'USER',
      status: 'active',
      deletedAt: null,
      fixtureKey: null,
      emailVerifiedAt: { $ne: null }
    });
    if (
      !user ||
      user.version >= Number.MAX_SAFE_INTEGER ||
      (await em.count(User, { role: 'ADMIN', fixtureKey: null }))
    )
      throw new Error('First administrator eligibility failed.');
    em.persist(Object.assign(new FirstAdminGrant(), { userId: user._id, email }));
    await em.flush();
    const changed = await em.nativeUpdate(
      User,
      {
        _id: user._id,
        email,
        version: user.version,
        role: 'USER',
        status: 'active',
        deletedAt: null,
        emailVerifiedAt: user.emailVerifiedAt,
        fixtureKey: null
      },
      { role: 'ADMIN', version: user.version + 1, updatedAt: new Date() }
    );
    if (changed !== 1) throw new Error('Account changed during provisioning.');
    em.clear();
  });
}
