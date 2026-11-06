import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested
} from 'class-validator';
import type { PropertyContent } from '@viedom/contracts';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class IdParams {
  @IsString() @Matches(/^[a-f0-9]{24}$/) id!: string;
}
export class VersionDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER - 1) expectedVersion!: number;
}
class PointDto {
  @Equals('Point') type!: 'Point';
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  coordinates!: [number, number];
}
class DetailsDto {
  @IsNumber() @Min(1) @Max(100_000) areaM2!: number;
  @IsInt() @Min(0) @Max(100) bedrooms!: number;
  @IsInt() @Min(0) @Max(100) bathrooms!: number;
  @IsInt() @Min(-10) @Max(200) floor!: number;
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1800)
  @Max(2100)
  yearBuilt!: number | null;
  @IsArray()
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(1, 50, { each: true })
  amenities!: string[];
}
class AddressDto {
  @Equals('GR') countryCode!: 'GR';
  @Transform(trim) @IsString() @Length(1, 100) city!: string;
  @Transform(trim) @IsString() @Length(0, 100) neighborhood!: string;
  @Transform(trim) @IsString() @Length(0, 200) street!: string;
}
export class PropertyDto implements PropertyContent {
  @IsIn(['apartment', 'house', 'studio']) type!: PropertyContent['type'];
  @IsObject() @ValidateNested() @Type(() => DetailsDto) details!: DetailsDto;
  @IsObject() @ValidateNested() @Type(() => AddressDto) address!: AddressDto;
  @IsObject() @ValidateNested() @Type(() => PointDto) privateLocation!: PointDto;
}
export class UpdatePropertyDto extends PropertyDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER - 1) expectedVersion!: number;
}
