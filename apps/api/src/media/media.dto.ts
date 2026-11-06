import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf
} from 'class-validator';
import { VersionDto } from '../properties/properties.dto.js';
import { MAX_GALLERY_IMAGES, MAX_IMAGE_BYTES } from './image-processor.js';

export class UploadMediaDto extends VersionDto {
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  contentType!: 'image/jpeg' | 'image/png' | 'image/webp';
  @IsInt() @Min(1) @Max(MAX_IMAGE_BYTES) bytes!: number;
}

export class CompleteMediaDto extends VersionDto {
  @IsString() @Matches(/^[a-f0-9]{24}$/) mediaId!: string;
}

export class GalleryDto extends VersionDto {
  @IsArray()
  @ArrayMaxSize(MAX_GALLERY_IMAGES)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[a-f0-9]{24}$/, { each: true })
  mediaIds!: string[];
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Matches(/^[a-f0-9]{24}$/)
  coverMediaId!: string | null;
}

export class MediaParams {
  @IsString() @Matches(/^[a-f0-9]{24}$/) id!: string;
  @IsString() @Matches(/^[a-f0-9]{24}$/) mediaId!: string;
}

export class VariantParams extends MediaParams {
  @IsIn(['large', 'thumbnail']) variant!: 'large' | 'thumbnail';
}
