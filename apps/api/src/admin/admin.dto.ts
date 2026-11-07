import { Transform } from 'class-transformer';
import { IsInt, IsString, Length, Matches, Max, Min, ValidateIf } from 'class-validator';
import { VersionDto } from '../properties/properties.dto.js';

export class PendingListingsQuery {
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

export class RejectListingDto extends VersionDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 2000)
  reason!: string;
}
