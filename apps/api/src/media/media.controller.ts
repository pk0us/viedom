import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import { ObjectId } from '@mikro-orm/mongodb';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/auth.guards.js';
import type { AuthRequest } from '../auth/auth.guards.js';
import { IdParams, VersionDto } from '../properties/properties.dto.js';
import {
  CompleteMediaDto,
  GalleryDto,
  MediaParams,
  UploadMediaDto,
  VariantParams
} from './media.dto.js';
import { MediaService } from './media.service.js';

function image(response: Response, body: Buffer): void {
  response.setHeader('Content-Type', 'image/webp');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Disposition', 'inline');
  response.send(body);
}

@Controller('listings/:id/media')
@UseGuards(JwtAuthGuard)
export class OwnerMediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  read(@Req() request: AuthRequest, @Param() params: IdParams) {
    return this.media.read(new ObjectId(request.user.id), new ObjectId(params.id));
  }

  @Post('upload-url')
  upload(@Req() request: AuthRequest, @Param() params: IdParams, @Body() body: UploadMediaDto) {
    return this.media.upload(new ObjectId(request.user.id), new ObjectId(params.id), body);
  }

  @Post('complete')
  @HttpCode(200)
  complete(@Req() request: AuthRequest, @Param() params: IdParams, @Body() body: CompleteMediaDto) {
    return this.media.complete(new ObjectId(request.user.id), new ObjectId(params.id), body);
  }

  @Patch()
  update(@Req() request: AuthRequest, @Param() params: IdParams, @Body() body: GalleryDto) {
    return this.media.update(new ObjectId(request.user.id), new ObjectId(params.id), body);
  }

  @Delete(':mediaId')
  remove(@Req() request: AuthRequest, @Param() params: MediaParams, @Body() body: VersionDto) {
    return this.media.remove(
      new ObjectId(request.user.id),
      new ObjectId(params.id),
      new ObjectId(params.mediaId),
      body.expectedVersion
    );
  }

  @Get(':mediaId/:variant')
  async image(
    @Req() request: AuthRequest,
    @Param() params: VariantParams,
    @Res() response: Response
  ) {
    image(
      response,
      await this.media.image(
        new ObjectId(params.id),
        new ObjectId(params.mediaId),
        params.variant,
        new ObjectId(request.user.id)
      )
    );
  }
}

@Controller('media')
export class PublicMediaController {
  constructor(private readonly media: MediaService) {}

  @Get(':id/:mediaId/:variant')
  async image(@Param() params: VariantParams, @Res() response: Response) {
    image(
      response,
      await this.media.image(
        new ObjectId(params.id),
        new ObjectId(params.mediaId),
        params.variant,
        null
      )
    );
  }
}
