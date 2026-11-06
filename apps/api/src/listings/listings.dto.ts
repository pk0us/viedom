import { Transform } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf
} from 'class-validator';
import type { ListingContent, ListingStatus } from '@viedom/contracts';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export class ListingDto implements ListingContent {
  @IsIn(['rent', 'sale']) transactionType!: 'rent' | 'sale';
  @Transform(trim) @IsString() @Length(0, 160) title!: string;
  @Transform(trim) @IsString() @Length(0, 10_000) description!: string;
  @IsInt() @Min(1) @Max(100_000_000_000) priceMinor!: number;
  @Equals('EUR') currency!: 'EUR';
}
export class CreateListingDto extends ListingDto {
  @IsString() @Matches(/^[a-f0-9]{24}$/) propertyId!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER - 1) expectedPropertyVersion!: number;
}
export class UpdateListingDto extends ListingDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER - 1) expectedVersion!: number;
}
export class OwnerListingsQuery {
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
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['draft', 'pending_review', 'rejected', 'published', 'paused', 'archived'])
  status?: ListingStatus;
}
