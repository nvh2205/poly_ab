import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UtilService } from '../../common/services/util.service';
import { PolymarketApiService } from '../../common/services/polymarket-api.service';
import { EventController } from './event.controller';
import { EventCrawlerService } from './event.service';
import { Event, Market } from '../../database/entities';

@Module({
  imports: [TypeOrmModule.forFeature([Event, Market])],
  controllers: [EventController],
  providers: [EventCrawlerService, UtilService, PolymarketApiService],
  exports: [EventCrawlerService],
})
export class EventModule {}
