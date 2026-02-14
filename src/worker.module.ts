import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';

// Entities
import { Market } from './database/entities/market.entity';
import { Event } from './database/entities/event.entity';

import { ArbRealTrade } from './database/entities/arb-real-trade.entity';
import { ArbSignal } from './database/entities/arb-signal.entity';
import { SellStatistics } from './database/entities/sell-statistics.entity';

// Modules
import { RedisModule } from './common/services/redis.module';
import { PolymarketOnchainWorkerModule } from './common/services/polymarket-onchain-worker.module';

// Queue Services & Processors
import { MINT_QUEUE_NAME } from './modules/strategy/services/mint-queue.service';
import { MintQueueProcessor } from './modules/strategy/services/mint-queue.processor';
import { MANAGE_POSITION_QUEUE_NAME } from './modules/strategy/services/manage-position-queue.service';
import { ManagePositionProcessor } from './modules/strategy/services/manage-position.processor';

// Worker Cron Service
import { WorkerCronService } from './modules/worker/worker-cron.service';
import { UtilService } from './common/services/util.service';
import { PolymarketApiService } from './common/services/polymarket-api.service';

import { APP_CONSTANTS } from './common/constants/app.constants';

/**
 * Worker Module
 * 
 * Includes:
 * - Database connection (to query market data)
 * - Bull Queue registration (to process jobs)
 * - Queue Processors (MintQueueProcessor, ManagePositionProcessor)
 * - Required services (PolymarketOnchainService)
 * - ScheduleModule + WorkerCronService (cron jobs separated from trading process)
 * 
 * Does NOT include:
 * - HTTP Controllers
 * - WebSocket services
 * - Strategy Engine services (ArbitrageEngine, RealExecution, etc.)
 */
@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: '.env',
        }),

        // NestJS Schedule for cron jobs in worker
        ScheduleModule.forRoot(),

        // Bull Queue configuration
        BullModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: (configService: ConfigService) => ({
                redis: {
                    host: configService.get('REDIS_HOST', 'localhost'),
                    port: configService.get<number>('REDIS_PORT', 6379),
                },
                defaultJobOptions: {
                    removeOnComplete: 100,
                    removeOnFail: 50,
                },
            }),
            inject: [ConfigService],
        }),

        // Database connection  
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
                    ArbRealTrade,
                    ArbSignal,
                    SellStatistics,
                ],
                synchronize: true,
                logging: false,
                extra: {
                    max: APP_CONSTANTS.DB_POOL_SIZE,
                },
            }),
            inject: [ConfigService],
        }),

        // Entity repositories for queue processors + cron service
        TypeOrmModule.forFeature([Market, Event, ArbRealTrade]),

        // Register queues for processing
        BullModule.registerQueue(
            {
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
            },
            {
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
            }
        ),

        // Required service modules - RedisModule is @Global but still needs to be imported
        RedisModule,
        PolymarketOnchainWorkerModule,
    ],
    providers: [
        // Queue Processors - auto-listen for jobs
        MintQueueProcessor,
        ManagePositionProcessor,

        // Cron jobs - run periodic tasks in worker process
        WorkerCronService,

        // Dependencies for WorkerCronService
        UtilService,
        PolymarketApiService,
    ],
})
export class WorkerModule { }
