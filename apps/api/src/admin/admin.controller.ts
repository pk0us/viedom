import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ObjectId } from '@mikro-orm/mongodb';
import type { Response } from 'express';
import { JwtAuthGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthRequest } from '../auth/auth.guards.js';
import { IdParams, VersionDto } from '../properties/properties.dto.js';
import { VariantParams } from '../media/media.dto.js';
import { PendingListingsQuery, RejectListingDto } from './admin.dto.js';
import { AdminService } from './admin.service.js';

function actor(request: AuthRequest) {
  if (!request.authSessionId) throw new UnauthorizedException();
  return { id: new ObjectId(request.user.id), sessionId: new ObjectId(request.authSessionId) };
}

@Controller('admin/listings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('pending')
  pending(@Req() request: AuthRequest, @Query() query: PendingListingsQuery) {
    return this.admin.pending(actor(request), query);
  }

  @Get(':id')
  detail(@Req() request: AuthRequest, @Param() params: IdParams) {
    return this.admin.detail(actor(request), new ObjectId(params.id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Req() request: AuthRequest, @Param() params: IdParams, @Body() body: VersionDto) {
    return this.admin.decide(actor(request), new ObjectId(params.id), body.expectedVersion, null);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Req() request: AuthRequest, @Param() params: IdParams, @Body() body: RejectListingDto) {
    return this.admin.decide(
      actor(request),
      new ObjectId(params.id),
      body.expectedVersion,
      body.reason
    );
  }

  @Get(':id/media/:mediaId/:variant')
  async image(
    @Req() request: AuthRequest,
    @Param() params: VariantParams,
    @Res() response: Response
  ) {
    const body = await this.admin.image(
      actor(request),
      new ObjectId(params.id),
      new ObjectId(params.mediaId),
      params.variant
    );
    response.setHeader('Content-Type', 'image/webp');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', 'inline');
    response.send(body);
  }
}
