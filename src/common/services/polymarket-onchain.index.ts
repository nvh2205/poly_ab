/**
 * Polymarket On-chain Service
 * Export all public interfaces and services
 */

export { PolymarketOnchainService } from './polymarket-onchain.service';
export { PolymarketOnchainController } from './polymarket-onchain.controller';
export { PolymarketOnchainModule } from './polymarket-onchain.module';

export type {
  PolymarketConfig,
  OrderParams,
  MarketCondition,
  BatchOrderParams,
  BatchOrderResult,
} from './polymarket-onchain.service';

export {
  loadPolymarketConfig,
  EXAMPLE_CONFIG,
  POLYMARKET_CONTRACTS,
  DEFAULT_GAS_CONFIG,
} from './polymarket-onchain.config';
