import { Module } from '@nestjs/common';
import { PolymarketOnchainService } from './polymarket-onchain.service';

/**
 * Polymarket Onchain Module for Worker
 * 
 * This module provides ONLY the PolymarketOnchainService without the controller.
 * Used by the Worker module which doesn't need HTTP endpoints.
 */
@Module({
    providers: [PolymarketOnchainService],
    exports: [PolymarketOnchainService],
})
export class PolymarketOnchainWorkerModule { }
