import { ValidationPipe } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ObjectId } from '@mikro-orm/mongodb';
import type { MikroORM } from '@mikro-orm/mongodb';
import type { Configuration } from '../configuration.js';
import type { AuthStore } from '../auth/auth.store.js';
import { InquiryOriginGuard } from './inquiries.controller.js';
import { CreateInquiryDto, InquiriesQuery, UpdateInquiryDto } from './inquiries.dto.js';
import { decodeInquiryCursor, InquiriesService, ownerInquiry } from './inquiries.service.js';
import { Inquiry, inquiryValidators } from './inquiries.entities.js';
import { openApiDocument } from '../openapi.js';
import type { OwnerWrites } from '../database/owner-writes.js';

const input = {
  name: 'Synthetic visitor',
  email: 'visitor@example.invalid',
  message: 'I would like to arrange a viewing.'
};
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const validate = (value: unknown, metatype = CreateInquiryDto as new () => object) =>
  pipe.transform(value, { type: 'body', metatype });

it('normalizes bounded input and rejects empty, malformed, injected, unknown and honeypot fields', async () => {
  expect(
    await validate({ ...input, name: ' Visitor ', email: ' VISITOR@example.invalid ' })
  ).toMatchObject({ name: 'Visitor', email: 'visitor@example.invalid' });
  for (const patch of [
    { name: ' ' },
    { name: 'x'.repeat(101) },
    { email: 'invalid' },
    { email: null },
    { message: 'short' },
    { message: 'x'.repeat(4001) },
    { message: { $ne: null } },
    { phone: null },
    { phone: '' },
    { phone: 'x'.repeat(33) },
    { website: 'https://spam.invalid' },
    { publisherId: new ObjectId().toHexString() },
    { senderId: new ObjectId().toHexString() }
  ])
    await expect(validate({ ...input, ...patch })).rejects.toThrow();
  await expect(
    validate({ ...input, phone: '+30 (210) 123-4567', website: '' })
  ).resolves.toBeDefined();
  await expect(
    validate({ status: 'read', publisherId: 'injected' }, UpdateInquiryDto)
  ).rejects.toThrow();
  await expect(validate({ status: 'other' }, UpdateInquiryDto)).rejects.toThrow();
  for (const value of [{ limit: '51' }, { limit: ['1', '2'] }, { cursor: '!!!' }, { unknown: 'x' }])
    await expect(validate(value, InquiriesQuery)).rejects.toThrow();
});

it('requires the configured origin and a custom submission header', () => {
  const guard = new InquiryOriginGuard({
    values: { webOrigin: 'http://localhost:4200' }
  } as Configuration);
  const context = (method: string, headers: object) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ method, headers }) }) }) as ExecutionContext;
  expect(
    guard.canActivate(
      context('POST', { origin: 'http://localhost:4200', 'x-inquiry-request': '1' })
    )
  ).toBe(true);
  expect(guard.canActivate(context('PATCH', { origin: 'http://localhost:4200' }))).toBe(true);
  for (const headers of [
    {},
    { origin: 'http://evil.invalid', 'x-inquiry-request': '1' },
    { origin: 'http://localhost:4200' }
  ])
    expect(() => guard.canActivate(context('POST', headers))).toThrow();
  expect(() => guard.canActivate(context('PATCH', {}))).toThrow();
});

it('binds strict keyset cursors to the publisher and returns an explicit confidential owner projection', () => {
  const owner = new ObjectId();
  const inquiry = Object.assign(new Inquiry(), {
    ...input,
    publisherId: owner,
    senderId: new ObjectId(),
    listingId: new ObjectId(),
    listingTitle: 'Synthetic listing'
  });
  const cursor = Buffer.from(
    JSON.stringify([
      inquiry.createdAt.toISOString(),
      inquiry._id.toHexString(),
      owner.toHexString()
    ])
  ).toString('base64url');
  expect(decodeInquiryCursor(cursor, owner).id).toEqual(inquiry._id);
  for (const value of [
    cursor + '=',
    '!!!',
    Buffer.from(
      JSON.stringify(['invalid', inquiry._id.toHexString(), owner.toHexString()])
    ).toString('base64url')
  ])
    expect(() => decodeInquiryCursor(value, owner)).toThrow();
  expect(() => decodeInquiryCursor(cursor, new ObjectId())).toThrow();
  expect(Object.keys(ownerInquiry(inquiry)).sort()).toEqual(
    [
      'createdAt',
      'email',
      'id',
      'listingId',
      'listingTitle',
      'message',
      'name',
      'phone',
      'status'
    ].sort()
  );
  expect(() => inquiry.toJSON()).toThrow();
});

it('rejects invalid identifiers and exhausted abuse limits before persistence', async () => {
  const limit = vi.fn().mockRejectedValue(new Error('limited'));
  const service = new InquiriesService(
    {} as MikroORM,
    { limit } as unknown as AuthStore,
    {} as OwnerWrites
  );
  await expect(service.submit('invalid', input, 'synthetic-ip', null)).rejects.toThrow();
  expect(limit).not.toHaveBeenCalled();
  await expect(
    service.submit(new ObjectId().toHexString(), input, 'synthetic-ip', null)
  ).rejects.toThrow('limited');
  expect(limit).toHaveBeenCalledWith('inquiry-ip', 'synthetic-ip', 10, 600);
});

it('keeps the API contract guest-accessible and inquiry persistence bounded without automatic retention deletion', () => {
  const paths = openApiDocument.paths;
  expect(paths['/listings/{id}/inquiries'].post.security).toEqual([{}, { bearerAuth: [] }]);
  expect(paths['/me/inquiries'].get.security).toEqual([{ bearerAuth: [] }]);
  expect(inquiryValidators.inquiries.$jsonSchema.additionalProperties).toBe(false);
  expect(inquiryValidators.inquiries.$jsonSchema.properties.message.maxLength).toBe(4000);
});
