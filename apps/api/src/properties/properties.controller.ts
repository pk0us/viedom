import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ObjectId } from '@mikro-orm/mongodb';
import { JwtAuthGuard } from '../auth/auth.guards.js';
import type { AuthRequest } from '../auth/auth.guards.js';
import { IdParams, PropertyDto, UpdatePropertyDto } from './properties.dto.js';
import { PropertiesService } from './properties.service.js';

@Controller('properties')
@UseGuards(JwtAuthGuard)
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}
  @Post()
  create(@Req() request: AuthRequest, @Body() body: PropertyDto) {
    return this.properties.create(new ObjectId(request.user.id), body);
  }
  @Get(':id')
  read(@Req() request: AuthRequest, @Param() params: IdParams) {
    return this.properties.read(new ObjectId(request.user.id), new ObjectId(params.id));
  }
  @Patch(':id')
  update(@Req() request: AuthRequest, @Param() params: IdParams, @Body() body: UpdatePropertyDto) {
    return this.properties.update(
      new ObjectId(request.user.id),
      new ObjectId(params.id),
      body.expectedVersion,
      body
    );
  }
}
