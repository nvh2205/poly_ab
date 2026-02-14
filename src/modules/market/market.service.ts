import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../../common/services/redis.service';
import { UtilService } from '../../common/services/util.service';
import { PolymarketApiService } from '../../common/services/polymarket-api.service';
import { MarketApiResponse } from '../../common/interfaces/market.interface';
import { IngestionService } from '../ingestion/ingestion.service';
import {
  WORKER_ACTIVE_TOKENS_KEY,
  WORKER_EXPIRED_TOKENS_KEY,
  WORKER_EXPIRED_GROUP_KEYS_KEY,
} from '../worker/worker-cron.service';
import {
  APP_CONSTANTS,
  SlugConfig,
} from '../../common/constants/app.constants';
import { Market } from '../../database/entities/market.entity';
import { MarketStructureService } from '../strategy/market-structure.service';
import { ArbitrageEngineTrioService } from '../strategy/arbitrage-engine-trio.service';
import { RustEngineBridgeService } from '../strategy/rust-engine-bridge.service';
import { isRustMode } from '../../common/config/run-mode';

@Injectable()
export class MarketService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MarketService.name);
  private readonly cacheTtl: number = APP_CONSTANTS.MARKET_CACHE_TTL;
  private readonly slugConfigs: SlugConfig[] = APP_CONSTANTS.SLUG_CONFIGS;

  constructor(
    private readonly redisService: RedisService,
    private readonly utilService: UtilService,
    private readonly polymarketApi: PolymarketApiService,
    private readonly ingestionService: IngestionService,
    private readonly marketStructureService: MarketStructureService,
    private readonly arbitrageEngineService: ArbitrageEngineTrioService,
    private readonly rustEngineBridgeService: RustEngineBridgeService,
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
  ) { }

  /**
   * Run immediately when application starts:
   * - Close expired markets (consume from Worker Redis)
   * - Subscribe to active market tokens via WebSocket
   */
  async onApplicationBootstrap() {
    this.logger.log(
      'Application started - triggering initial market subscription...',
    );
    try {
      await this.crawlMarketsForSocketSubscription();
      this.logger.log('Initial market subscription completed successfully');
    } catch (error) {
      this.logger.error('Error in initial market subscription:', error.message);
    }
  }

  /**
   * Expired markets in-memory cleanup — reads from Redis (Worker writes).
   * Consumes expired tokens and groupKeys in parallel, then deletes the Redis keys.
   * No DB queries here — Worker handles all DB operations.
   * Called from crawlMarketsForSocketSubscription every 20 min + on app bootstrap.
   */
  private async processExpiredMarketsFromRedis(): Promise<void> {
    try {
      // Read both keys in parallel
      const [expiredTokensRaw, expiredGroupKeysRaw] = await Promise.all([
        this.redisService.get(WORKER_EXPIRED_TOKENS_KEY),
        this.redisService.get(WORKER_EXPIRED_GROUP_KEYS_KEY),
      ]);

      // Process expired tokens + groupKeys in parallel
      const tasks: Promise<void>[] = [];

      if (expiredTokensRaw) {
        const expiredTokens: string[] = JSON.parse(expiredTokensRaw);
        if (expiredTokens.length > 0) {
          this.logger.log(
            `Unsubscribing from ${expiredTokens.length} expired tokens (from Worker)`,
          );
          tasks.push(
            this.ingestionService
              .unsubscribeFromTokens(expiredTokens)
              .then(() => { this.redisService.del(WORKER_EXPIRED_TOKENS_KEY); }),
          );
        } else {
          tasks.push(this.redisService.del(WORKER_EXPIRED_TOKENS_KEY).then(() => { }));
        }
      }

      if (expiredGroupKeysRaw) {
        const groupKeys: string[] = JSON.parse(expiredGroupKeysRaw);
        if (groupKeys.length > 0) {
          const cleanedGroups = this.marketStructureService.cleanupExpiredGroups(groupKeys);
          const cleanedEngineGroups = this.arbitrageEngineService.cleanupExpiredGroups(groupKeys);
          // Also cleanup Rust engine if active
          if (isRustMode()) {
            this.rustEngineBridgeService.cleanupExpiredGroups(groupKeys);
          }
          this.logger.log(
            `Cleaned up ${cleanedGroups} groups from market structure cache and ${cleanedEngineGroups} groups from arbitrage engine cache (from Worker)`,
          );
        }
        // Delete key after consuming
        tasks.push(this.redisService.del(WORKER_EXPIRED_GROUP_KEYS_KEY).then(() => { }));
      }

      if (tasks.length > 0) {
        await Promise.all(tasks);
      }
    } catch (error) {
      this.logger.error(
        'Error processing expired markets from Redis:',
        error.message,
      );
    }
  }

  /**
   * Job runs every 20 minutes — reads active token list from Redis (Worker writes)
   * and subscribes to any new tokens via WebSocket.
   * Also runs immediately on app bootstrap (onApplicationBootstrap).
   * No DB queries here — Worker handles the heavy DB query.
   *
   * Interval rationale: Markets change once per day (daily expiry/creation),
   * so 20 min is sufficient. Initial run on boot ensures immediate sync.
   */
  @Interval(1000 * 60 * 20) // Every 20 minutes
  async crawlMarketsForSocketSubscription() {
    try {

      // 1. Process any expired markets FIRST (unsubscribe + cleanup stale groups)
      //    This must run before ensureBootstrapped() to prevent race condition:
      //    ensureBootstrapped() rebuilds structure, then cleanup wipes it.
      await this.processExpiredMarketsFromRedis();

      // 2. Sync engine after cleanup — ensures structure only contains valid groups
      if (isRustMode()) {
        await this.rustEngineBridgeService.ensureBootstrapped();
      } else {
        await this.arbitrageEngineService.ensureBootstrapped();
      }

      // 3. Read active tokens list from Redis (Worker queries DB every 30s)
      const tokensRaw = await this.redisService.get(WORKER_ACTIVE_TOKENS_KEY);
      if (!tokensRaw) {
        this.logger.debug('No active tokens in Redis (Worker may not be running), falling back to DB');
        await this.crawlMarketsForSocketSubscriptionFromDB();
        return;
      }

      const uniqueTokens: string[] = JSON.parse(tokensRaw);
      if (uniqueTokens.length === 0) {
        return;
      }

      // Filter out already subscribed tokens (in-memory check, <1ms)
      const subscriptionStatus =
        this.ingestionService.areTokensSubscribed(uniqueTokens);
      const tokensToSubscribe = uniqueTokens.filter(
        (_, index) => !subscriptionStatus[index],
      );

      if (tokensToSubscribe.length === 0) {
        this.logger.debug('All tokens already subscribed');
        return;
      }

      this.logger.log(
        `Found ${tokensToSubscribe.length} new tokens (out of ${uniqueTokens.length} total) from Redis`,
      );

      // Subscribe to new tokens (in-memory WebSocket management)
      await this.ingestionService.subscribeToTokens(tokensToSubscribe);

      this.logger.log(
        `Crawl job completed: subscribed to ${tokensToSubscribe.length} new tokens`,
      );
    } catch (error) {
      this.logger.error(
        'Error in crawl markets for socket subscription:',
        error.message,
      );
    }
  }

  /**
   * Fallback: query DB directly when Worker is not running.
   * This ensures main process can operate independently.
   */
  private async crawlMarketsForSocketSubscriptionFromDB(): Promise<void> {
    const now = new Date();
    const marketsToCheck = await this.marketRepository
      .createQueryBuilder('market')
      .select([
        'market.id',
        'market.clobTokenIds',
      ])
      .where('market.active = :active', { active: true })
      .andWhere('market.startTime IS NOT NULL')
      // Exclude markets that expired but cleanup hasn't run yet
      .andWhere('(market.endDate IS NULL OR market.endDate > :now)', { now })
      .getMany();

    if (marketsToCheck.length === 0) return;

    const allTokens: string[] = [];
    for (const market of marketsToCheck) {
      if (
        market.clobTokenIds &&
        Array.isArray(market.clobTokenIds) &&
        market.clobTokenIds.length > 0
      ) {
        allTokens.push(...market.clobTokenIds);
      }
    }

    const uniqueTokens = [...new Set(allTokens)];
    if (uniqueTokens.length === 0) return;

    const subscriptionStatus =
      this.ingestionService.areTokensSubscribed(uniqueTokens);
    const tokensToSubscribe = uniqueTokens.filter(
      (_, index) => !subscriptionStatus[index],
    );

    if (tokensToSubscribe.length === 0) return;

    this.logger.log(
      `[Fallback DB] Found ${tokensToSubscribe.length} new tokens from ${marketsToCheck.length} markets`,
    );
    await this.ingestionService.subscribeToTokens(tokensToSubscribe);
  }

  /**
   * Fetch market data from Polymarket API
   */
  async fetchMarketBySlug(slug: string): Promise<MarketApiResponse | null> {
    return this.polymarketApi.fetchMarketBySlug(slug);
  }

  /**
   * Get all active tokens
   */
  async getActiveTokens(): Promise<string[]> {
    return this.redisService.smembers('active_clob_tokens');
  }

  /**
   * Get active tokens with metadata
   */
  async getActiveTokensWithMetadata(): Promise<any[]> {
    const tokenIds = await this.getActiveTokens();
    const tokensWithMetadata = [];

    for (const tokenId of tokenIds) {
      const metadataStr = await this.redisService.get(
        `token_metadata:${tokenId}`,
      );
      const metadata = metadataStr ? JSON.parse(metadataStr) : null;

      tokensWithMetadata.push({
        tokenId,
        ...metadata,
      });
    }

    return tokensWithMetadata;
  }

  /**
   * Get all slug patterns that would be generated now
   */
  async getAllCurrentSlugs(): Promise<any[]> {
    return this.slugConfigs.map((config) => ({
      crypto: config.crypto,
      interval: config.interval,
      pattern: config.pattern,
      slug: this.utilService.generateSlug(config),
    }));
  }

  /**
   * Get market by slug from database
   */
  async getMarketBySlug(slug: string): Promise<Market | null> {
    try {
      const market = await this.marketRepository.findOne({
        where: { slug },
      });
      return market;
    } catch (error) {
      this.logger.error(
        `Error fetching market by slug ${slug}:`,
        error.message,
      );
      return null;
    }
  }
}
