import { Passwords, csrfFor, digest, equalToken, randomToken } from './auth.crypto.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto, LoginDto } from './auth.dto.js';

it('hashes with independent salts and checks absent/malformed/wrong credentials safely', async () => {
  const passwords = new Passwords();
  const hash = await passwords.hash('A long test passphrase');
  expect(hash).not.toContain('passphrase');
  expect(await passwords.verify('A long test passphrase', hash)).toBe(true);
  expect(await passwords.verify('a different password', hash)).toBe(false);
  expect(await passwords.verify('A long test passphrase', null)).toBe(false);
  expect(await passwords.verify('A long test passphrase', 'scrypt$bad')).toBe(false);
  expect(await passwords.hash('A long test passphrase')).not.toBe(hash);
}, 15_000);

it('binds CSRF tokens to their purpose and handles malformed/unicode input without throwing', () => {
  const secret = randomToken();
  expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(digest(randomToken())).toMatch(/^[a-f0-9]{64}$/);
  expect(csrfFor(secret, 'session:1')).not.toBe(csrfFor(secret, 'session:2'));
  expect(csrfFor(secret, 'session:1')).not.toBe(csrfFor(secret, 'bootstrap:1'));
  expect(equalToken(['x'], 'x')).toBe(false);
  expect(equalToken('é', 'a')).toBe(false);
  expect(equalToken('valid', 'valid')).toBe(true);
});

it('normalizes email, retains the exact password, and rejects privilege injection/nested input', async () => {
  const dto = plainToInstance(RegisterDto, {
    email: '  Person@Example.invalid ',
    password: '  twelve spaces matter  ',
    firstName: ' Person ',
    lastName: ' Test '
  });
  expect(await validate(dto)).toHaveLength(0);
  expect(dto.email).toBe('person@example.invalid');
  expect(dto.password).toBe('  twelve spaces matter  ');
  expect(dto.firstName).toBe('Person');
  expect(
    await validate(plainToInstance(RegisterDto, { ...dto, role: 'ADMIN' }), {
      whitelist: true,
      forbidNonWhitelisted: true
    })
  ).not.toHaveLength(0);
  expect(
    await validate(plainToInstance(LoginDto, { email: { $ne: null }, password: 'x' }))
  ).not.toHaveLength(0);
  expect(
    await validate(plainToInstance(RegisterDto, { ...dto, password: 'short' }))
  ).not.toHaveLength(0);
});
