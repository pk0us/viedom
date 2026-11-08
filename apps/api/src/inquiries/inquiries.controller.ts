import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ObjectId } from '@mikro-orm/mongodb';
import type { Request } from 'express';
import type { CurrentUser } from '@viedom/contracts';
import { Configuration } from '../configuration.js';
import { JwtAuthGuard } from '../auth/auth.guards.js';
import type { AuthRequest } from '../auth/auth.guards.js';
import { IdParams } from '../properties/properties.dto.js';
import { InquiriesService } from './inquiries.service.js';
import { CreateInquiryDto, InquiriesQuery, UpdateInquiryDto } from './inquiries.dto.js';

@Injectable()
export class OptionalInquiryAuthGuard extends AuthGuard('jwt') {
  override canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    return request.headers.authorization === undefined ? true : super.canActivate(context);
  }
}

@Injectable()
export class InquiryOriginGuard implements CanActivate {
  constructor(private readonly configuration: Configuration) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (
      request.headers.origin !== this.configuration.values.webOrigin ||
      (request.method === 'POST' && request.headers['x-inquiry-request'] !== '1')
    )
      throw new ForbiddenException();
    return true;
  }
}

@Controller('listings')
export class InquiriesController {
  constructor(private readonly inquiries: InquiriesService) {}
  @Post(':id/inquiries')
  @UseGuards(InquiryOriginGuard, OptionalInquiryAuthGuard)
  submit(
    @Req() request: Request & { user?: CurrentUser },
    @Param('id') id: string,
    @Body() body: CreateInquiryDto
  ) {
    return this.inquiries.submit(id, body, request.ip ?? '', request.user?.id ?? null);
  }
}

@Controller('me/inquiries')
@UseGuards(JwtAuthGuard)
export class OwnerInquiriesController {
  constructor(private readonly inquiries: InquiriesService) {}
  @Get()
  list(@Req() request: AuthRequest, @Query() query: InquiriesQuery) {
    return this.inquiries.list(new ObjectId(request.user.id), query);
  }
  @Patch(':id')
  @UseGuards(InquiryOriginGuard)
  update(@Req() request: AuthRequest, @Param() params: IdParams, @Body() body: UpdateInquiryDto) {
    return this.inquiries.update(new ObjectId(request.user.id), new ObjectId(params.id), body);
  }
}
