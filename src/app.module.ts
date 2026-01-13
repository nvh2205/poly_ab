import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { DatabaseModule } from './database/database.module';
import { MarketModule } from './modules/market/market.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { RedisModule } from './common/services/redis.module';
import { ClickHouseModule } from './common/services/clickhouse.module';
import { PolymarketOnchainModule } from './common/services/polymarket-onchain.module';
import { APP_CONSTANTS } from './common/constants/app.constants';
import { Market } from './database/entities/market.entity';
import { Event } from './database/entities/event.entity';
import { ArbSignal } from './database/entities/arb-signal.entity';
import { ArbPaperTrade } from './database/entities/arb-paper-trade.entity';
import { ArbRealTrade } from './database/entities/arb-real-trade.entity';
import { SellStatistics } from './database/entities/sell-statistics.entity';
import { EventModule } from './modules/event/event.module';
import { StrategyModule } from './modules/strategy/strategy.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        username: configService.get('DB_USERNAME'),
        password: configService.get('DB_PASSWORD'),
        database: configService.get('DB_DATABASE'),
        entities: [
          Market,
          Event,
          ArbSignal,
          ArbPaperTrade,
          ArbRealTrade,
          SellStatistics,
        ], // Import entities directly
        synchronize: true, // Auto-sync database schema
        logging: false, // Enable logging to see CREATE TABLE queries
        extra: {
          max: APP_CONSTANTS.DB_POOL_SIZE,
        },
      }),
      inject: [ConfigService],
    }),
    DatabaseModule, // Global database module
    RedisModule,
    ClickHouseModule,
    PolymarketOnchainModule,
    MarketModule,
    EventModule,
    IngestionModule,
    StrategyModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
