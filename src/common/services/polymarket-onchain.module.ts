import { Module } from '@nestjs/common';
import { PolymarketOnchainService } from './polymarket-onchain.service';
import { PolymarketOnchainController } from './polymarket-onchain.controller';

@Module({
  controllers: [PolymarketOnchainController],
  providers: [PolymarketOnchainService],
  exports: [PolymarketOnchainService],
})
export class PolymarketOnchainModule {}
