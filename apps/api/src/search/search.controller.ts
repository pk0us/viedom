import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import {
  ListingMarkersQueryDto,
  ListingSearchQueryDto,
  ListingSitemapQueryDto
} from './search.dto.js';
import { SearchService } from './search.service.js';

@Controller('listings')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get('search')
  @Header('Cache-Control', 'no-store')
  search(@Query() query: ListingSearchQueryDto) {
    return this.searchService.search(query);
  }

  @Get('markers')
  @Header('Cache-Control', 'no-store')
  markers(@Query() query: ListingMarkersQueryDto) {
    return this.searchService.markers(query);
  }

  @Get('recent')
  @Header('Cache-Control', 'no-store')
  recent() {
    return this.searchService.recent();
  }

  @Get('sitemap')
  @Header('Cache-Control', 'no-store')
  sitemap(@Query() query: ListingSitemapQueryDto) {
    return this.searchService.sitemap(query.cursor);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  detail(@Param('id') id: string) {
    return this.searchService.detail(id);
  }
}
