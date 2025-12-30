import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { Market } from '../../database/entities';
import { MarketData, PriceChangeData } from '../../common/interfaces/market.interface';
import { APP_CONSTANTS } from '../../common/constants/app.constants';
import { RedisService } from '../../common/services/redis.service';
import { ClickHouseService } from '../../common/services/clickhouse.service';

@Injectable()
export class BufferService implements OnModuleInit {
  private readonly logger = new Logger(BufferService.name);
  private buffer: MarketData[] = [];
  private readonly batchSize: number = APP_CONSTANTS.CLICKHOUSE_BATCH_SIZE;
  private readonly flushInterval: number = APP_CONSTANTS.CLICKHOUSE_FLUSH_INTERVAL_MS;
  private isProcessing = false;
  private marketSlugToMarketIdCache: Map<string, string> = new Map();
  private readonly orderbookTable = 'market_orderbooks_analytics';
  private readonly unknownMarketSlug = '__unknown__';
  private readonly unknownMarketId = '__unknown__';
  /**
   * Some sources may send seconds, some milliseconds; normalize to unix ms.
   */
  private normalizeTimestampMs(ts: number): number {
    if (!Number.isFinite(ts)) return Date.now();
    // If it's clearly milliseconds (>= year 2001 in ms), keep as ms.
    if (ts >= 1_000_000_000_000) return Math.floor(ts);
    // Otherwise treat as seconds.
    return Math.floor(ts * 1000);
  }

  /**
   * Format unix ms to ClickHouse DateTime64(3) string: "YYYY-MM-DD HH:mm:ss.SSS" (UTC)
   */
  private toClickHouseDateTime64_3(ms: number): string {
    const d = new Date(ms);
    const pad2 = (n: number) => n.toString().padStart(2, '0');
    const pad3 = (n: number) => n.toString().padStart(3, '0');
    const yyyy = d.getUTCFullYear();
    const MM = pad2(d.getUTCMonth() + 1);
    const dd = pad2(d.getUTCDate());
    const hh = pad2(d.getUTCHours());
    const mm = pad2(d.getUTCMinutes());
    const ss = pad2(d.getUTCSeconds());
    const SSS = pad3(d.getUTCMilliseconds());
    return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}.${SSS}`;
  }

  constructor(
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
    private readonly redisService: RedisService,
    private readonly clickHouseService: ClickHouseService,
  ) {
    this.logger.log(
      `Buffer initialized with batch size: ${this.batchSize}, flush interval: ${this.flushInterval}ms`,
    );
  }

  async onModuleInit() {
    await this.ensureClickHouseTable();
  }

  /**
   * Push new data to buffer
   */
  push(data: MarketData): void {
    this.buffer.push(data);

    // Auto-flush if buffer reaches batch size
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  /**
   * Push price change data to buffer
   */
  pushPriceChange(data: PriceChangeData): void {
    // TODO: Implement price change storage logic
    // For now, just log the received data
    this.logger.debug(`Received price change for asset ${data.asset_id}: ${data.price} ${data.side}`);
  }

  /**
   * Flush buffer every interval (time-based)
   */
  @Interval(APP_CONSTANTS.CLICKHOUSE_FLUSH_INTERVAL_MS)
  async handleInterval() {
    if (this.buffer.length > 0 && !this.isProcessing) {
      await this.flush();
    }
  }

  /**
   * Calculate best bid/ask, spread, and price from orderbook levels
   * Spread = best ask - best bid
   * Price = (best ask + best bid) / 2
   */
  private calculateOrderbookMetrics(
    bids: any[],
    asks: any[],
  ): { bestBid: number; bestAsk: number; spread: number; price: number } {
    try {
      if (!bids || !asks || bids.length === 0 || asks.length === 0) {
        return {
          bestBid: Number.NaN,
          bestAsk: Number.NaN,
          spread: Number.NaN,
          price: Number.NaN,
        };
      }

      // Helper function to extract price from different formats
      const extractPrice = (item: any): number | null => {
        if (Array.isArray(item)) {
          return parseFloat(item[0]);
        }
        if (item && typeof item === 'object') {
          return parseFloat(item.price ?? item[0]);
        }
        return parseFloat(item);
      };

      // Find max bid price (highest bid)
      let maxBidPrice: number | null = null;
      for (const bid of bids) {
        const price = extractPrice(bid);
        if (price !== null && !isNaN(price)) {
          if (maxBidPrice === null || price > maxBidPrice) {
            maxBidPrice = price;
          }
        }
      }

      // Find min ask price (lowest ask)
      let minAskPrice: number | null = null;
      for (const ask of asks) {
        const price = extractPrice(ask);
        if (price !== null && !isNaN(price)) {
          if (minAskPrice === null || price < minAskPrice) {
            minAskPrice = price;
          }
        }
      }

      if (
        maxBidPrice === null ||
        minAskPrice === null ||
        isNaN(maxBidPrice) ||
        isNaN(minAskPrice)
      ) {
        return {
          bestBid: Number.NaN,
          bestAsk: Number.NaN,
          spread: Number.NaN,
          price: Number.NaN,
        };
      }

      // Spread = min(asks) - max(bids)
      const spread = minAskPrice - maxBidPrice;
      // Mid price = (best ask + best bid) / 2
      const price = (minAskPrice + maxBidPrice) / 2;

      return {
        bestBid: maxBidPrice,
        bestAsk: minAskPrice,
        spread,
        price,
      };
    } catch (error) {
      this.logger.debug(
        `Error calculating orderbook metrics: ${error.message}`,
      );
      return {
        bestBid: Number.NaN,
        bestAsk: Number.NaN,
        spread: Number.NaN,
        price: Number.NaN,
      };
    }
  }

  /**
   * Convert levels to numeric arrays for ClickHouse (Array(Float64)).
   * Supports:
   * - [{ price: "0.5", size: "10" }, ...]
   * - [["0.5","10"], ...]
   */
  private levelsToArrays(levels: any[] | undefined | null): {
    price: number[];
    size: number[];
  } {
    if (!levels || levels.length === 0) return { price: [], size: [] };
    const price: number[] = [];
    const size: number[] = [];

    for (const level of levels) {
      let p: any;
      let s: any;
      if (Array.isArray(level)) {
        p = level[0];
        s = level[1];
      } else if (level && typeof level === 'object') {
        p = level.price ?? level[0];
        s = level.size ?? level[1];
      } else {
        continue;
      }

      const pn = typeof p === 'number' ? p : parseFloat(String(p));
      const sn = typeof s === 'number' ? s : parseFloat(String(s));
      if (Number.isFinite(pn) && Number.isFinite(sn)) {
        price.push(pn);
        size.push(sn);
      }
    }
    return { price, size };
  }

  /**
   * Get slug from token metadata in Redis
   */
  private async getSlugFromToken(assetId: string): Promise<string | null> {
    try {
      const metadataStr = await this.redisService.get(
        `token_metadata:${assetId}`,
      );
      if (metadataStr) {
        const metadata = JSON.parse(metadataStr);
        return metadata.slug || null;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get market ID from market slug (with caching)
   */
  private async getMarketIdFromSlug(slug: string): Promise<string | null> {
    if (!slug) return null;

    if (this.marketSlugToMarketIdCache.has(slug)) {
      return this.marketSlugToMarketIdCache.get(slug) || null;
    }

    try {
      const market = await this.marketRepository.findOne({
        where: { slug },
        select: ['id'],
      });
      if (market?.id) {
        this.marketSlugToMarketIdCache.set(slug, market.id);
        return market.id;
      }
      return null;
    } catch (error) {
      this.logger.debug(
        `Error finding market for slug ${slug}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Flush buffer to database
   */
  async flush(): Promise<void> {
    if (this.isProcessing || this.buffer.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      // Take current buffer and reset immediately
      const dataToSave = [...this.buffer];
      this.buffer = [];

      // Transform data to ClickHouse format with slug and spread
      const entities = await Promise.all(
        dataToSave.map(async (data) => {
          // Get slug from Redis token metadata
          const slug = await this.getSlugFromToken(data.asset_id);
          const marketId = slug ? await this.getMarketIdFromSlug(slug) : null;

          const bidsArr = this.levelsToArrays(data.bids);
          const asksArr = this.levelsToArrays(data.asks);

          // Calculate best bid/ask, spread, price
          const { bestBid, bestAsk, spread, price } = this.calculateOrderbookMetrics(
            data.bids || [],
            data.asks || [],
          );

          const tsMs = this.normalizeTimestampMs(Number(data.timestamp));
          const ts = this.toClickHouseDateTime64_3(tsMs);

          return {
            market_hash: data.market,
            asset_id: data.asset_id,
            market_slug: slug || this.unknownMarketSlug,
            market_id: marketId || this.unknownMarketId,
            timestamp: ts,
            bids_price: bidsArr.price,
            bids_size: bidsArr.size,
            asks_price: asksArr.price,
            asks_size: asksArr.size,
            best_bid: bestBid,
            best_ask: bestAsk,
            spread: spread,
            price: price,
          };
        }),
      );

      // Bulk insert into ClickHouse
      if (entities.length > 0) {
        await this.clickHouseService.insert(this.orderbookTable, entities);
        this.logger.log(`Flushed ${entities.length} records to ClickHouse`);
      }
    } catch (error) {
      this.logger.error('Error flushing buffer:', error.message);
      // In production, you might want to implement retry logic or dead-letter queue
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Ensure ClickHouse orderbook table exists
   */
  private async ensureClickHouseTable(): Promise<void> {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS ${this.orderbookTable} (
        timestamp DateTime64(3),
        market_hash LowCardinality(String),
        market_slug LowCardinality(String),
        market_id LowCardinality(String),
        asset_id LowCardinality(String),
        bids_price Array(Float64),
        bids_size Array(Float64),
        asks_price Array(Float64),
        asks_size Array(Float64),
        best_bid Float64,
        best_ask Float64,
        spread Float64,
        price Float64
      )
      ENGINE = MergeTree()
      ORDER BY (market_slug, timestamp)
      SETTINGS index_granularity = 8192
    `;

    try {
      await this.clickHouseService.command(createTableQuery);

      // If the table already existed (older schema), CREATE IF NOT EXISTS won't update it.
      // Ensure new columns exist via additive migrations.
      const alterStatements: string[] = [
        `ALTER TABLE ${this.orderbookTable} ADD COLUMN IF NOT EXISTS market_hash LowCardinality(String)`,
        `ALTER TABLE ${this.orderbookTable} ADD COLUMN IF NOT EXISTS market_slug LowCardinality(String)`,
        `ALTER TABLE ${this.orderbookTable} ADD COLUMN IF NOT EXISTS market_id LowCardinality(String)`,
        `ALTER TABLE ${this.orderbookTable} ADD COLUMN IF NOT EXISTS asset_id LowCardinality(String)`,
        `ALTER TABLE ${this.orderbookTable} ADD COLUMN IF NOT EXISTS bids_price Array(Float64)`,
        `ALTER TABLE ${this.orderbookTable} ADD COLUMN IF NOT EXISTS bids_size Array(Float64)`,
        `ALTER TABLE ${this.orderbookTable} ADD COLUMN IF NOT EXISTS asks_price Array(Float64)`,
        `ALTER TABLE ${this.orderbookTable} ADD COLUMN IF NOT EXISTS asks_size Array(Float64)`,
        `ALTER TABLE ${this.orderbookTable} ADD COLUMN IF NOT EXISTS best_bid Float64`,
        `ALTER TABLE ${this.orderbookTable} ADD COLUMN IF NOT EXISTS best_ask Float64`,
        `ALTER TABLE ${this.orderbookTable} ADD COLUMN IF NOT EXISTS spread Float64`,
        `ALTER TABLE ${this.orderbookTable} ADD COLUMN IF NOT EXISTS price Float64`,
      ];

      for (const stmt of alterStatements) {
        await this.clickHouseService.command(stmt);
      }

      this.logger.log('ClickHouse orderbook table is ready');
    } catch (error) {
      this.logger.error('Failed to ensure ClickHouse table:', error.message);
      throw error;
    }
  }


  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Force flush (for graceful shutdown)
   */
  async forceFlush(): Promise<void> {
    this.logger.log('Force flushing buffer...');
    await this.flush();
  }
}
