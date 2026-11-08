import { Transform } from 'class-transformer';
import {
  Equals,
  IsEmail,
  IsIn,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf
} from 'class-validator';
import type { CreateInquiryRequest, InquiryStatus, UpdateInquiryRequest } from '@viedom/contracts';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateInquiryDto implements CreateInquiryRequest {
  @Transform(trim) @IsString() @Length(1, 100) name!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value
  )
  @IsEmail()
  @Length(3, 254)
  email!: string;
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 32)
  @Matches(/^[+()0-9 .-]+$/)
  phone?: string;
  @Transform(trim) @IsString() @Length(10, 4000) message!: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Equals('')
  website?: string;
}

export class UpdateInquiryDto implements UpdateInquiryRequest {
  @IsIn(['unread', 'read', 'archived']) status!: InquiryStatus;
}

export class InquiriesQuery {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[0-9]{1,2}$/.test(value) ? Number(value) : value
  )
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 256)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}
