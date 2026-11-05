import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { HttpException, Injectable } from '@nestjs/common';

export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const csrfFor = (secret: string, purpose: string) =>
  createHmac('sha256', secret).update(`viedom.csrf.${purpose}`).digest('base64url');
export function equalToken(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** OWASP scrypt baseline. Async and bounded to avoid exhausting memory/threadpool. */
@Injectable()
export class Passwords {
  private running = 0;
  private async derive(password: string, salt: Buffer): Promise<Buffer> {
    if (this.running >= 2) throw new HttpException('Busy', 429);
    this.running++;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(
          password,
          salt,
          64,
          { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 },
          (error, result) => (error ? reject(error) : resolve(result))
        );
      });
    } finally {
      this.running--;
    }
  }
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    return `scrypt$131072$8$1$${salt.toString('hex')}$${(await this.derive(password, salt)).toString('hex')}`;
  }
  async verify(password: string, encoded: string | null): Promise<boolean> {
    const match = /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded ?? '');
    const actual = await this.derive(
      password,
      match ? Buffer.from(match[1]!, 'hex') : Buffer.alloc(16)
    );
    const expected = match ? Buffer.from(match[2]!, 'hex') : Buffer.alloc(64);
    return timingSafeEqual(actual, expected) && Boolean(match);
  }
}
