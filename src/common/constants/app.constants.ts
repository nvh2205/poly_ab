/**
 * Application Constants
 * These values are hardcoded and should not be changed via environment variables
 */

// Slug configuration types
export type SlugPattern = 'timestamp' | 'datetime' | 'daily';
export type TimeInterval = '15m' | '1h' | '4h' | 'daily';
export type CryptoAsset = 'btc' | 'eth' | 'solana';

export interface SlugConfig {
  pattern: SlugPattern;
  baseSlug: string;
  interval: TimeInterval;
  crypto: CryptoAsset;
}

export const APP_CONSTANTS = {
  // Polymarket API Configuration
  POLYMARKET_API_URL: 'https://gamma-api.polymarket.com',
  POLYMARKET_WS_URL: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',

  // Market Discovery Configuration
  MARKET_CACHE_TTL: 1800, // 30 minutes in seconds

  // Slug Configurations for different patterns
  SLUG_CONFIGS: [
    // Pattern 1: Timestamp-based slugs (btc-updown-15m-1764612000)
    {
      pattern: 'timestamp',
      baseSlug: 'btc-updown-15m',
      interval: '15m',
      crypto: 'btc',
    },
    {
      pattern: 'timestamp',
      baseSlug: 'eth-updown-15m',
      interval: '15m',
      crypto: 'eth',
    },
    // { pattern: 'timestamp', baseSlug: 'solana-updown-15m', interval: '15m', crypto: 'sol' },

    // { pattern: 'timestamp', baseSlug: 'btc-updown-4h', interval: '4h', crypto: 'btc' },
    // { pattern: 'timestamp', baseSlug: 'eth-updown-4h', interval: '4h', crypto: 'eth' },
    // { pattern: 'timestamp', baseSlug: 'solana-updown-4h', interval: '4h', crypto: 'sol' },

    // // Pattern 2: DateTime-based slugs (bitcoin-up-or-down-december-1-1pm-et)
    // { pattern: 'datetime', baseSlug: 'bitcoin-up-or-down', interval: '1h', crypto: 'btc' },
    // { pattern: 'datetime', baseSlug: 'ethereum-up-or-down', interval: '1h', crypto: 'eth' },
    // { pattern: 'datetime', baseSlug: 'solana-up-or-down', interval: '1h', crypto: 'solana' },

    // // Pattern 3: Daily slugs (bitcoin-up-or-down-on-december-1)
    // { pattern: 'daily', baseSlug: 'bitcoin-up-or-down-on', interval: 'daily', crypto: 'btc' },
    // { pattern: 'daily', baseSlug: 'ethereum-up-or-down-on', interval: 'daily', crypto: 'eth' },
    // { pattern: 'daily', baseSlug: 'solana-up-or-down-on', interval: 'daily', crypto: 'solana' },
  ] as SlugConfig[],

  // Event Slug Configurations (used for /events/slug/{slug})
  // Examples (for Dec 29): bitcoin-above-on-december-29, bitcoin-price-on-december-29, etc.
  EVENT_SLUG_CONFIGS: [
    {
      pattern: 'daily',
      baseSlug: 'bitcoin-above-on',
      interval: 'daily',
      crypto: 'btc',
    },
    {
      pattern: 'daily',
      baseSlug: 'bitcoin-price-on',
      interval: 'daily',
      crypto: 'btc',
    },
    {
      pattern: 'daily',
      baseSlug: 'ethereum-above-on',
      interval: 'daily',
      crypto: 'eth',
    },
    {
      pattern: 'daily',
      baseSlug: 'ethereum-price-on',
      interval: 'daily',
      crypto: 'eth',
    },
  ] as SlugConfig[],

  // WebSocket Configuration
  MAX_TOKENS_PER_SOCKET: 50, // Polymarket limit
  PING_INTERVAL_MS: 10000, // 10 seconds

  // Performance Tuning
  BATCH_SIZE: 1000, // Number of records before flush
  FLUSH_INTERVAL_MS: 1000, // 1 second

  // Database Configuration
  DB_POOL_SIZE: 50,

  // ClickHouse Configuration
  CLICKHOUSE_BATCH_SIZE: 10000, // Number of records before flush to ClickHouse
  CLICKHOUSE_FLUSH_INTERVAL_MS: 5000, // 5 seconds
} as const;
