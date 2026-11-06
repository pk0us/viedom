import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { EntityManager, MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { PersistenceConflict } from './snapshots.js';
import { Property, User } from './entities.js';

@Injectable()
export class OwnerWrites {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(
    ownerId: ObjectId,
    work: (em: EntityManager, owner: User) => Promise<T>
  ): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        const owner = await em.findOne(User, { _id: ownerId, status: 'active', deletedAt: null });
        if (!owner) throw new ForbiddenException();
        if (owner.version >= Number.MAX_SAFE_INTEGER) throw new PersistenceConflict();
        const changed = await em.nativeUpdate(
          User,
          { _id: ownerId, version: owner.version, status: 'active', deletedAt: null },
          {
            version: owner.version + 1,
            updatedAt: new Date()
          }
        );
        if (changed !== 1) throw new PersistenceConflict();
        const result = await work(em, owner);
        em.clear();
        return result;
      });
    } catch (error) {
      if (error instanceof PersistenceConflict || transactionConflict(error))
        throw new ConflictException();
      throw error;
    }
  }
}

export async function fenceProperty(em: EntityManager, property: Property): Promise<Date> {
  const updatedAt = new Date(Math.max(Date.now(), property.updatedAt.getTime() + 1));
  const changed = await em.nativeUpdate(
    Property,
    {
      _id: property._id,
      ownerId: property.ownerId,
      version: property.version
    },
    { updatedAt }
  );
  if (changed !== 1) throw new PersistenceConflict();
  return updatedAt;
}

function transactionConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && [112, 244, 251].includes(error.code as number)) return true;
  return (
    'hasErrorLabel' in error &&
    typeof error.hasErrorLabel === 'function' &&
    (error.hasErrorLabel('TransientTransactionError') ||
      error.hasErrorLabel('UnknownTransactionCommitResult'))
  );
}
