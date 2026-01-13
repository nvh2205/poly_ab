import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketService } from './market.service';
import { MarketController } from './market.controller';
import { UtilService } from '../../common/services/util.service';
import { PolymarketApiService } from '../../common/services/polymarket-api.service';
import { IngestionModule } from '../ingestion/ingestion.module';
import { StrategyModule } from '../strategy/strategy.module';
import { Market } from '../../database/entities/market.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Market]),
    IngestionModule,
    StrategyModule,
  ],
  controllers: [MarketController],
  providers: [MarketService, UtilService, PolymarketApiService],
  exports: [MarketService],
})
export class MarketModule {}
