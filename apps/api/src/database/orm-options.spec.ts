import { MikroORM } from '@mikro-orm/mongodb';
import type { Options } from '@mikro-orm/mongodb';
import { initializeOrm, ormOptions } from './orm-options.js';

it('preserves the Mongo initializer receiver and forwards configuration and result unchanged', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(MikroORM, 'init')!;
  const expected = {} as MikroORM;
  const receivers: (typeof MikroORM)[] = [];
  let configuration: Options | undefined;
  Object.defineProperty(MikroORM, 'init', {
    ...descriptor,
    value: function (this: typeof MikroORM, options: Options): Promise<MikroORM> {
      receivers.push(this);
      configuration = options;
      return Promise.resolve(expected);
    }
  });
  try {
    const options = ormOptions('mongodb://127.0.0.1:27017', 'synthetic_initializer_test');
    expect(await initializeOrm(options)).toBe(expected);
    expect(receivers).toEqual([MikroORM]);
    expect(configuration).toBe(options);
  } finally {
    Object.defineProperty(MikroORM, 'init', descriptor);
  }
});
