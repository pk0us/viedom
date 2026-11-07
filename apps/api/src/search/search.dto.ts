import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf
} from 'class-validator';
import type { ListingSearchFilters, PropertyType, SearchBounds } from '@viedom/contracts';

const numeric = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? Number(value) : value;

export class ListingMarkersQueryDto implements SearchBounds, ListingSearchFilters {
  @Transform(numeric)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  west!: number;
  @Transform(numeric)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  south!: number;
  @Transform(numeric)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  east!: number;
  @Transform(numeric)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  north!: number;
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['rent', 'sale'])
  transactionType?: 'rent' | 'sale';
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(numeric)
  @IsInt()
  @Min(0)
  @Max(100_000_000_000)
  minPrice?: number;
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(numeric)
  @IsInt()
  @Min(0)
  @Max(100_000_000_000)
  maxPrice?: number;
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(numeric)
  @IsInt()
  @Min(0)
  @Max(100)
  minBedrooms?: number;
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(numeric)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(100_000)
  minAreaM2?: number;
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['apartment', 'house', 'studio'])
  propertyType?: PropertyType;
}

export class ListingSearchQueryDto extends ListingMarkersQueryDto {
  @Transform(numeric)
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
