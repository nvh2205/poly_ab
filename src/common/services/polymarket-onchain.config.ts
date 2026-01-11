/**
 * Polymarket Configuration Helper
 * Use this to load configuration from environment variables
 */

import type { PolymarketConfig } from './polymarket-onchain.service';

/**
 * Load Polymarket configuration from environment variables
 */
export function loadPolymarketConfig(): PolymarketConfig {
  const config: PolymarketConfig = {
    polygonRpc: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
    chainId: parseInt(process.env.CHAIN_ID || '137', 10),
    clobUrl: process.env.CLOB_URL || 'https://clob.polymarket.com',
    privateKey: process.env.PRIVATE_KEY || '',
    proxyAddress:
      process.env.PROXY_ADDRESS || '0xb9b5cde0d64a06f5315be41a3ef2bbb530990fa5',
    apiKey: process.env.POLYMARKET_API_KEY,
    apiSecret: process.env.POLYMARKET_API_SECRET,
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
  };

  // Validate required fields
  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY environment variable is required');
  }

  if (!config.polygonRpc) {
    throw new Error('POLYGON_RPC environment variable is required');
  }

  return config;
}

/**
 * Example configuration (DO NOT USE IN PRODUCTION)
 * Replace with your own values or use environment variables
 */
export const EXAMPLE_CONFIG: PolymarketConfig = {
  polygonRpc:
    'https://silent-virulent-ensemble.matic.quiknode.pro/YOUR_API_KEY',
  chainId: 137,
  clobUrl: 'https://clob.polymarket.com',
  privateKey: '0xYOUR_PRIVATE_KEY_HERE', // NEVER commit real private key
  proxyAddress: '0xb9b5cde0d64a06f5315be41a3ef2bbb530990fa5',
};

/**
 * Contract addresses on Polygon Mainnet (Fixed)
 */
export const POLYMARKET_CONTRACTS = {
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
};

/**
 * Default gas configuration (500 gwei as per requirements)
 */
export const DEFAULT_GAS_CONFIG = {
  MAX_FEE_PER_GAS: '500', // gwei
  MAX_PRIORITY_FEE_PER_GAS: '500', // gwei
  GAS_LIMIT: 1000000,
};

/**
 * Environment variables needed:
 *
 * Required:
 * - POLYGON_RPC: Polygon RPC URL
 * - PRIVATE_KEY: Private key of EOA wallet (0x...)
 *
 * Optional:
 * - CHAIN_ID: Default 137 (Polygon mainnet)
 * - CLOB_URL: Default https://clob.polymarket.com
 * - PROXY_ADDRESS: Default 0xb9b5cde0d64a06f5315be41a3ef2bbb530990fa5
 * - POLYMARKET_API_KEY: Auto-generated if not provided
 * - POLYMARKET_API_SECRET: Auto-generated if not provided
 * - POLYMARKET_API_PASSPHRASE: Auto-generated if not provided
 */
