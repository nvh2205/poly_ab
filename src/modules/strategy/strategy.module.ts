import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Market } from '../../database/entities/market.entity';
import { Event } from '../../database/entities/event.entity';
import { ArbSignal } from '../../database/entities/arb-signal.entity';
import { ArbPaperTrade } from '../../database/entities/arb-paper-trade.entity';
import { ArbRealTrade } from '../../database/entities/arb-real-trade.entity';
// import { SellStatistics } from '../../database/entities/sell-statistics.entity'; // DEPRECATED: No longer used
import { MarketStructureService } from './market-structure.service';
import { IngestionModule } from '../ingestion/ingestion.module';
import { ArbitrageEngineService } from './arbitrage-engine.service';
import { PaperExecutionService } from './paper-execution.service';
import { RealExecutionService } from './real-execution.service';
import { StrategyController } from './strategy.controller';
import { RetentionCleanupService } from './retention-cleanup.service';
import { PolymarketOnchainModule } from '../../common/services/polymarket-onchain.module';
import { TelegramModule } from '../../common/services/telegram.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Market,
      Event,
      ArbSignal,
      ArbPaperTrade,
      ArbRealTrade,
      // SellStatistics, // DEPRECATED: No longer used
    ]),
    IngestionModule,
    PolymarketOnchainModule,
    TelegramModule,
  ],
  controllers: [StrategyController],
  providers: [
    MarketStructureService,
    ArbitrageEngineService,
    PaperExecutionService,
    RealExecutionService,
    RetentionCleanupService,
  ],
  exports: [
    MarketStructureService,
    ArbitrageEngineService,
    PaperExecutionService,
    RealExecutionService,
  ],
})
export class StrategyModule {}
