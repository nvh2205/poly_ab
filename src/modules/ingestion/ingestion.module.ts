import { Module } from '@nestjs/common';
import { IngestionService } from './ingestion.service';
import { IngestionController } from './ingestion.controller';
import { SocketManagerService } from './socket-manager.service';
import { BufferService } from './buffer.service';
import { UtilService } from '../../common/services/util.service';
import { RedisModule } from '../../common/services/redis.module';
import { MarketDataStreamService } from './market-data-stream.service';

@Module({
  imports: [RedisModule],
  controllers: [IngestionController],
  providers: [
    IngestionService,
    SocketManagerService,
    BufferService,
    UtilService,
    MarketDataStreamService,
  ],
  exports: [IngestionService, MarketDataStreamService],
})
export class IngestionModule {}
