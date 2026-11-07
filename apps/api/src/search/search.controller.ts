import { Controller, Get, Header, Query } from '@nestjs/common';
import { ListingMarkersQueryDto, ListingSearchQueryDto } from './search.dto.js';
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
}
