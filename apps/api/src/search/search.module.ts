import { Module } from '@nestjs/common';
import { Configuration } from '../configuration.js';
import { DatabaseModule } from '../database/database.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [SearchController],
  providers: [Configuration, SearchService]
})
export class SearchModule {}
