import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
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
import { TradeAnalysisService } from './trade-analysis.service';
import { StrategyController } from './strategy.controller';
import { RetentionCleanupService } from './retention-cleanup.service';
import { PolymarketOnchainModule } from '../../common/services/polymarket-onchain.module';
import { TelegramModule } from '../../common/services/telegram.module';
import { MintQueueService, MINT_QUEUE_NAME } from './services/mint-queue.service';
import { MintQueueProcessor } from './services/mint-queue.processor';
import { ManagePositionQueueService, MANAGE_POSITION_QUEUE_NAME } from './services/manage-position-queue.service';
import { ManagePositionProcessor } from './services/manage-position.processor';

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
    // Register Bull Queue for minting
    BullModule.registerQueue({
      name: MINT_QUEUE_NAME,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    }),
    // Register Bull Queue for manage-position (order status checking)
    BullModule.registerQueue({
      name: MANAGE_POSITION_QUEUE_NAME,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    }),
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
    TradeAnalysisService,
    RetentionCleanupService,
    MintQueueService,
    MintQueueProcessor,
    ManagePositionQueueService,
    ManagePositionProcessor,
  ],
  exports: [
    MarketStructureService,
    ArbitrageEngineService,
    PaperExecutionService,
    RealExecutionService,
    TradeAnalysisService,
    MintQueueService,
    ManagePositionQueueService,
  ],
})
export class StrategyModule { }
