import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../../common/services/redis.service';
import { UtilService } from '../../common/services/util.service';
import { PolymarketApiService } from '../../common/services/polymarket-api.service';
import { MarketApiResponse } from '../../common/interfaces/market.interface';
import { IngestionService } from '../ingestion/ingestion.service';
import {
  APP_CONSTANTS,
  SlugConfig,
} from '../../common/constants/app.constants';
import { Market } from '../../database/entities/market.entity';
import { MarketStructureService } from '../strategy/market-structure.service';
import { ArbitrageEngineService } from '../strategy/arbitrage-engine.service';

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
    private readonly arbitrageEngineService: ArbitrageEngineService,
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
  ) {}

  /**
   * Run market discovery immediately when application starts
   */
  async onApplicationBootstrap() {
    this.logger.log(
      'Application started - triggering initial market discovery...',
    );
    try {
      // await this.handleMarketDiscovery();
      this.logger.log('Initial market discovery completed successfully');
    } catch (error) {
      this.logger.error('Error in initial market discovery:', error.message);
    }
  }

  /**
   * Cron job runs every 15 minutes to check and remove expired markets
   */
  @Cron('0 */4 * * * *') // Every 15 minutes
  async handleExpiredMarketsCleanup() {
    this.logger.log('Starting expired markets cleanup...');
    try {
      const now = new Date();

      // Find all active markets with endDate < now (include event relation for groupKey calculation)
      const expiredMarketsToClose = await this.marketRepository
        .createQueryBuilder('market')
        .leftJoinAndSelect('market.event', 'event')
        .where('market.active = :active', { active: true })
        .andWhere('market.endDate IS NOT NULL')
        .andWhere('market.endDate < :now', { now })
        .getMany();

      if (expiredMarketsToClose.length === 0) {
        this.logger.debug('No expired markets found');
        return;
      }

      this.logger.log(
        `Found ${expiredMarketsToClose.length} expired markets to cleanup`,
      );

      const allExpiredTokens: string[] = [];

      for (const market of expiredMarketsToClose) {
        try {
          // Collect tokens from expired markets
          if (market.clobTokenIds && market.clobTokenIds.length > 0) {
            allExpiredTokens.push(...market.clobTokenIds);
          }

          // Update market status
          market.active = false;
          market.closed = true;
          await this.marketRepository.save(market);

          this.logger.log(
            `Marked market as closed: ${market.marketId} (${market.slug})`,
          );
        } catch (error) {
          this.logger.error(
            `Error closing market ${market.marketId}:`,
            error.message,
          );
        }
      }

      // Unsubscribe from expired tokens if any
      if (allExpiredTokens.length > 0) {
        // Remove duplicates
        const uniqueExpiredTokens = [...new Set(allExpiredTokens)];
        this.logger.log(
          `Unsubscribing from ${uniqueExpiredTokens.length} expired tokens`,
        );
        await this.ingestionService.unsubscribeFromTokens(uniqueExpiredTokens);
      }

      // Cleanup expired markets from memory cache by groupKey
      // Calculate groupKeys from expired markets using MarketStructureService
      const groupKeysToCleanup = new Set<string>();
      for (const market of expiredMarketsToClose) {
        const groupKey = this.marketStructureService.calculateGroupKey(market);
        groupKeysToCleanup.add(groupKey);
      }

      if (groupKeysToCleanup.size > 0) {
        try {
          const groupKeysArray = Array.from(groupKeysToCleanup);
          const cleanedGroups = this.marketStructureService.cleanupExpiredGroups(
            groupKeysArray,
          );
          const cleanedEngineGroups =
            this.arbitrageEngineService.cleanupExpiredGroups(groupKeysArray);
          this.logger.log(
            `Cleaned up ${cleanedGroups} groups from market structure cache and ${cleanedEngineGroups} groups from arbitrage engine cache`,
          );
        } catch (error) {
          this.logger.error(
            `Error cleaning up expired markets from cache: ${error.message}`,
          );
        }
      }

      this.logger.log(
        `Expired markets cleanup completed. Closed ${expiredMarketsToClose.length} markets, unsubscribed from ${allExpiredTokens.length} tokens`,
      );
    } catch (error) {
      this.logger.error('Error in expired markets cleanup:', error.message);
    }
  }

  /**
   * Job runs every 5 seconds to check markets with startTime <= current
   * and subscribe to socket if not already subscribed
   */
  @Interval(1000 * 60 * 0.5) // Every 5 minutes
  async crawlMarketsForSocketSubscription() {
    try {
      // Ensure arbitrage engine is bootstrapped (if groups were cleaned up after market expiry)
      // This is safe to call multiple times - will skip if already bootstrapped
      await this.arbitrageEngineService.ensureBootstrapped();

      const now = new Date();

      // Query markets with startTime <= current time and active = true using query builder
      const marketsToCheck = await this.marketRepository
        .createQueryBuilder('market')
        .select([
          'market.id',
          'market.slug',
          'market.clobTokenIds',
          'market.startTime',
          'market.marketId',
          'market.type',
        ])
        .where('market.active = :active', { active: true })
        .andWhere('market.startTime IS NOT NULL')
        // .andWhere('market.endDate > :now', { now })
        .getMany();

      if (marketsToCheck.length === 0) {
        return; // No markets to process
      }

      this.logger.debug(
        `Found ${marketsToCheck.length} markets with startTime <= current time`,
      );

      // Collect all tokens from all markets
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

      if (allTokens.length === 0) {
        this.logger.debug('No tokens found in markets');
        return;
      }

      // Remove duplicates
      const uniqueTokens = [...new Set(allTokens)];

      // Filter out already subscribed tokens
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
        `Found ${tokensToSubscribe.length} new tokens (out of ${uniqueTokens.length} total) from ${marketsToCheck.length} markets`,
      );

      // Subscribe to all tokens (SocketManagerService will handle chunking into groups of 50)
      await this.ingestionService.subscribeToTokens(tokensToSubscribe);

      this.logger.log(
        `Crawl job completed: subscribed to ${tokensToSubscribe.length} new tokens from ${marketsToCheck.length} markets`,
      );
    } catch (error) {
      this.logger.error(
        'Error in crawl markets for socket subscription:',
        error.message,
      );
    }
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
