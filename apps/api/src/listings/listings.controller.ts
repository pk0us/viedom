import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { ObjectId } from '@mikro-orm/mongodb';
import { JwtAuthGuard, VerifiedEmailGuard } from '../auth/auth.guards.js';
import type { AuthRequest } from '../auth/auth.guards.js';
import { IdParams, VersionDto } from '../properties/properties.dto.js';
import { CreateListingDto, OwnerListingsQuery, UpdateListingDto } from './listings.dto.js';
import { ListingsService } from './listings.service.js';
import { ListingsPreviewService } from './listings-preview.service.js';

@Controller('listings')
@UseGuards(JwtAuthGuard)
export class ListingsController {
  constructor(private readonly listings: ListingsService) {}
  @Post()
  create(@Req() request: AuthRequest, @Body() body: CreateListingDto) {
    return this.listings.create(new ObjectId(request.user.id), body);
  }
  @Patch(':id')
  update(@Req() request: AuthRequest, @Param() params: IdParams, @Body() body: UpdateListingDto) {
    return this.listings.update(new ObjectId(request.user.id), new ObjectId(params.id), body);
  }
  @Post(':id/submit')
  @HttpCode(200)
  @UseGuards(VerifiedEmailGuard)
  submit(@Req() request: AuthRequest, @Param() params: IdParams, @Body() body: VersionDto) {
    return this.listings.action(
      new ObjectId(request.user.id),
      new ObjectId(params.id),
      body.expectedVersion,
      'submit'
    );
  }
  @Post(':id/pause')
  @HttpCode(200)
  pause(@Req() request: AuthRequest, @Param() params: IdParams, @Body() body: VersionDto) {
    return this.listings.action(
      new ObjectId(request.user.id),
      new ObjectId(params.id),
      body.expectedVersion,
      'pause'
    );
  }
  @Post(':id/resume')
  @HttpCode(200)
  @UseGuards(VerifiedEmailGuard)
  resume(@Req() request: AuthRequest, @Param() params: IdParams, @Body() body: VersionDto) {
    return this.listings.action(
      new ObjectId(request.user.id),
      new ObjectId(params.id),
      body.expectedVersion,
      'resume'
    );
  }
  @Post(':id/archive')
  @HttpCode(200)
  archive(@Req() request: AuthRequest, @Param() params: IdParams, @Body() body: VersionDto) {
    return this.listings.action(
      new ObjectId(request.user.id),
      new ObjectId(params.id),
      body.expectedVersion,
      'archive'
    );
  }
}

@Controller('me/listings')
@UseGuards(JwtAuthGuard)
export class OwnerListingsController {
  constructor(
    private readonly listings: ListingsService,
    private readonly previews: ListingsPreviewService
  ) {}
  @Get()
  list(@Req() request: AuthRequest, @Query() query: OwnerListingsQuery) {
    return this.listings.list(new ObjectId(request.user.id), query);
  }
  @Get(':id/preview')
  preview(@Req() request: AuthRequest, @Param() params: IdParams) {
    return this.previews.read(new ObjectId(request.user.id), new ObjectId(params.id));
  }
  @Get(':id')
  read(@Req() request: AuthRequest, @Param() params: IdParams) {
    return this.listings.read(new ObjectId(request.user.id), new ObjectId(params.id));
  }
}
