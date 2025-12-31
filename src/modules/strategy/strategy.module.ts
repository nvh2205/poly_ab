import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Market } from '../../database/entities/market.entity';
import { Event } from '../../database/entities/event.entity';
import { ArbSignal } from '../../database/entities/arb-signal.entity';
import { ArbPaperTrade } from '../../database/entities/arb-paper-trade.entity';
import { MarketStructureService } from './market-structure.service';
import { IngestionModule } from '../ingestion/ingestion.module';
import { ArbitrageEngineService } from './arbitrage-engine.service';
import { PaperExecutionService } from './paper-execution.service';
import { StrategyController } from './strategy.controller';
import { RetentionCleanupService } from './retention-cleanup.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Market, Event, ArbSignal, ArbPaperTrade]),
    IngestionModule,
  ],
  controllers: [StrategyController],
  providers: [
    MarketStructureService,
    ArbitrageEngineService,
    PaperExecutionService,
    RetentionCleanupService,
  ],
  exports: [
    MarketStructureService,
    ArbitrageEngineService,
    PaperExecutionService,
  ],
})
export class StrategyModule {}

