import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Market } from '../../database/entities/market.entity';
import { Event } from '../../database/entities/event.entity';

import {
    APP_CONSTANTS,
    SlugConfig,
} from '../../common/constants/app.constants';
import { UtilService } from '../../common/services/util.service';
import { PolymarketApiService } from '../../common/services/polymarket-api.service';
import {
    PolymarketOnchainService,
    PolymarketConfig,
} from '../../common/services/polymarket-onchain.service';
import { loadPolymarketConfig } from '../../common/services/polymarket-onchain.config';
import { RedisService } from '../../common/services/redis.service';

// ============================================================================
// Types (copied from event.service.ts)
// ============================================================================
type PolymarketEventResponse = {
    id: string;
    slug: string;
    ticker?: string;
    title?: string;
    subtitle?: string;
    active?: boolean;
    closed?: boolean;
    archived?: boolean;
    startDate?: string;
    creationDate?: string;
    endDate?: string;
    markets?: Array<Record<string, any>>;
    [key: string]: any;
};

/** Redis key for USDC balance (written by worker, read by main process) */
export const WORKER_USDC_BALANCE_KEY = 'worker:usdc_balance';

/** Redis key for active market token IDs (JSON array of strings) */
export const WORKER_ACTIVE_TOKENS_KEY = 'worker:active_market_tokens';

/** Redis key for expired tokens to unsubscribe (JSON array, consumed once by main) */
export const WORKER_EXPIRED_TOKENS_KEY = 'worker:expired_tokens';

/** Redis key for expired group keys to cleanup (JSON array, consumed once by main) */
export const WORKER_EXPIRED_GROUP_KEYS_KEY = 'worker:expired_group_keys';

/** Balance refresh interval */
const BALANCE_REFRESH_MS = 5000; // 5 seconds

/** Market tokens crawl interval */
const MARKET_TOKENS_CRAWL_MS = 20 * 60 * 1000; // 20 minutes (markets change daily)

/**
 * Worker Cron Service
 *
 * Runs periodic background jobs in the WORKER process, separated from the
 * main trading process to avoid impacting HFT latency.
 *
 * Jobs:
 * 1. USDC Balance refresh (every 5s) - RPC call to blockchain, writes to Redis
 * 2. Event crawling (hourly) - fetches events from Polymarket API
 * 3. Active market tokens crawl (every 20 min) - queries DB, writes to Redis
 * 4. Expired markets DB cleanup (every 4 min) - marks expired markets as closed + writes to Redis
 */
@Injectable()
export class WorkerCronService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(WorkerCronService.name);

    // Event crawl configs
    private readonly eventSlugConfigs: SlugConfig[] =
        APP_CONSTANTS.EVENT_SLUG_CONFIGS;

    // Balance refresh state
    private config!: PolymarketConfig;
    private balanceRefreshInterval?: ReturnType<typeof setInterval>;
    private marketTokensCrawlInterval?: ReturnType<typeof setInterval>;

    constructor(
        @InjectRepository(Market)
        private readonly marketRepository: Repository<Market>,
        @InjectRepository(Event)
        private readonly eventRepository: Repository<Event>,
        private readonly utilService: UtilService,
        private readonly polymarketApi: PolymarketApiService,
        private readonly polymarketOnchainService: PolymarketOnchainService,
        private readonly redisService: RedisService,
    ) {
        this.logger.log('WorkerCronService initialized');
    }

    // ============================================================================
    // Lifecycle
    // ============================================================================

    async onModuleInit(): Promise<void> {
        // Load Polymarket config for RPC calls
        this.config = loadPolymarketConfig();
        this.logger.log('Polymarket config loaded for balance refresh');

        // Initial balance fetch
        this.refreshBalanceToRedis();

        // Initial market tokens crawl
        this.crawlActiveMarketTokensToRedis();

        // Setup periodic balance refresh (every 5s)
        this.balanceRefreshInterval = setInterval(() => {
            this.refreshBalanceToRedis();
        }, BALANCE_REFRESH_MS);
        this.logger.log(
            `Balance refresh to Redis scheduled every ${BALANCE_REFRESH_MS}ms`,
        );

        // Setup periodic market tokens crawl (every 30s)
        this.marketTokensCrawlInterval = setInterval(() => {
            this.crawlActiveMarketTokensToRedis();
        }, MARKET_TOKENS_CRAWL_MS);
        this.logger.log(
            `Market tokens crawl to Redis scheduled every ${MARKET_TOKENS_CRAWL_MS}ms`,
        );
    }

    onModuleDestroy(): void {
        if (this.balanceRefreshInterval) {
            clearInterval(this.balanceRefreshInterval);
        }
        if (this.marketTokensCrawlInterval) {
            clearInterval(this.marketTokensCrawlInterval);
        }
    }

    // ============================================================================
    // 0. BALANCE REFRESH (moved from real-execution.service.ts)
    // ============================================================================

    /**
     * Fetch USDC balance via RPC call and write to Redis.
     * Main process reads from Redis instead of making direct RPC calls.
     * This removes the heavy blockchain RPC I/O from the trading hot path.
     */
    private refreshBalanceToRedis(): void {
        const targetAddress = this.config.proxyAddress || undefined;
        this.polymarketOnchainService
            .getBalances(this.config, undefined, targetAddress)
            .then((balances) => {
                const usdcBalance = balances.usdc;
                // Write to Redis with 30s TTL (stale safety)
                this.redisService
                    .set(WORKER_USDC_BALANCE_KEY, usdcBalance, 30)
                    .catch((err) => {
                        this.logger.warn(
                            `Failed to write balance to Redis: ${err.message}`,
                        );
                    });
            })
            .catch((error) => {
                this.logger.warn(
                    `Balance refresh RPC failed: ${error.message}`,
                );
            });
    }

    // ============================================================================
    // 0b. ACTIVE MARKET TOKENS CRAWL (moved from market.service.ts)
    // ============================================================================

    /**
     * Query active markets from DB and write token IDs to Redis.
     * Main process reads this list to subscribe WebSocket channels.
     * This moves the heavy DB query out of the main trading process.
     */
    private async crawlActiveMarketTokensToRedis(): Promise<void> {
        try {
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

            // Remove duplicates
            const uniqueTokens = [...new Set(allTokens)];

            // Write to Redis with 2400s TTL (40 min = 2× crawl interval, stale safety)
            await this.redisService.set(
                WORKER_ACTIVE_TOKENS_KEY,
                JSON.stringify(uniqueTokens),
                2400,
            );

            this.logger.debug(
                `Wrote ${uniqueTokens.length} active tokens to Redis from ${marketsToCheck.length} markets`,
            );
        } catch (error) {
            this.logger.warn(
                `Active market tokens crawl failed: ${error.message}`,
            );
        }
    }

    // ============================================================================
    // 1. EVENT CRAWL (from event.service.ts)
    // ============================================================================

    /**
     * Run every 1 hour - crawl events from Polymarket API and upsert to DB
     */
    @Cron('0 0 * * * *')
    async crawlEvents(): Promise<void> {
        const startedAt = Date.now();
        this.logger.log(
            `Starting event crawl, configs=${this.eventSlugConfigs.length}`,
        );

        for (const config of this.eventSlugConfigs) {
            const slug = this.utilService.generateSlug(config);
            try {
                await this.fetchAndSaveEventBySlug(slug, config.crypto);
            } catch (error) {
                this.logger.error(
                    `Failed to crawl event slug=${slug}:`,
                    error?.message,
                );
            }
        }

        this.logger.log(`Event crawl finished in ${Date.now() - startedAt}ms`);
    }

    private async fetchAndSaveEventBySlug(
        slug: string,
        crypto?: string,
    ): Promise<Event> {
        const cryptoValue = crypto || this.findCryptoFromSlug(slug);
        if (!cryptoValue) {
            this.logger.warn(
                `Could not determine crypto from slug=${slug}, using 'btc' as default`,
            );
        }

        const eventData = await this.polymarketApi.fetchEventBySlug(slug);
        if (!eventData) {
            throw new Error(`Event not found: ${slug}`);
        }

        const savedEvent = await this.upsertEvent(eventData);
        await this.upsertMarketsFromEvent(
            savedEvent,
            eventData?.markets,
            cryptoValue || 'btc',
        );
        return savedEvent;
    }

    private findCryptoFromSlug(slug: string): string | null {
        for (const config of this.eventSlugConfigs) {
            if (config.pattern === 'daily' && slug.startsWith(config.baseSlug)) {
                return config.crypto;
            }
            if (
                config.pattern === 'timestamp' &&
                slug.startsWith(config.baseSlug + '-')
            ) {
                return config.crypto;
            }
            if (
                config.pattern === 'datetime' &&
                slug.startsWith(config.baseSlug + '-')
            ) {
                return config.crypto;
            }
        }
        return null;
    }

    private async upsertEvent(payload: PolymarketEventResponse): Promise<Event> {
        if (!payload?.id) {
            throw new Error('Event payload missing id');
        }
        if (!payload?.slug) {
            throw new Error('Event payload missing slug');
        }

        const existing =
            (await this.eventRepository.findOne({
                where: [{ eventId: payload.id }, { slug: payload.slug }],
            })) || null;

        const now = new Date();
        const entity = existing || this.eventRepository.create();

        entity.eventId = payload.id;
        entity.slug = payload.slug;
        entity.ticker = (payload.ticker as any) ?? null;
        entity.title = (payload.title as any) ?? null;
        entity.subtitle = (payload.subtitle as any) ?? null;
        entity.active = payload.active ?? null;
        entity.closed = payload.closed ?? null;
        entity.archived = payload.archived ?? null;
        entity.startDate = this.utilService.parseDate(payload.startDate);
        entity.creationDate = this.utilService.parseDate(payload.creationDate);
        entity.endDate = this.utilService.parseDate(payload.endDate);
        entity.data = payload;
        entity.lastCrawledAt = now;

        return await this.eventRepository.save(entity);
    }

    private async upsertMarketsFromEvent(
        event: Event,
        markets: Array<Record<string, any>> | undefined,
        crypto: string,
    ): Promise<void> {
        if (!Array.isArray(markets) || markets.length === 0) {
            return;
        }

        const results = await Promise.allSettled(
            markets.map((m) => this.upsertMarketFromEventData(event, m, crypto)),
        );

        const errors = results.filter((r) => r.status === 'rejected');
        if (errors.length > 0) {
            this.logger.warn(
                `Failed to upsert ${errors.length} markets from eventId=${event?.eventId}`,
            );
        }
    }

    private async upsertMarketFromEventData(
        event: Event,
        marketData: Record<string, any>,
        crypto: string,
    ): Promise<void> {
        const marketId = marketData?.id ? String(marketData.id) : null;
        const slug = marketData?.slug ? String(marketData.slug) : null;

        if (!marketId && !slug) {
            this.logger.debug('Skipping market: missing both id and slug');
            return;
        }

        const existing = await this.marketRepository.findOne({
            where: [
                ...(marketId ? [{ marketId }] : []),
                ...(slug ? [{ slug }] : []),
            ],
        });

        const market = existing || this.marketRepository.create();

        if (marketId) market.marketId = marketId;
        if (slug) market.slug = slug;
        market.event = event;

        market.question = marketData?.question ?? market.question ?? null;
        market.conditionId =
            marketData?.conditionId ??
            marketData?.condition_id ??
            market.conditionId ??
            null;
        market.questionID =
            marketData?.questionID ??
            marketData?.question_id ??
            market.questionID ??
            null;

        market.active =
            market.active !== undefined
                ? market.active
                : marketData?.active !== undefined
                    ? Boolean(marketData.active)
                    : true;
        market.closed =
            marketData?.closed !== undefined
                ? Boolean(marketData.closed)
                : (market.closed ?? false);

        market.creationDate =
            this.utilService.parseDate(
                marketData?.creationDate ?? marketData?.createdAt,
            ) ?? market.creationDate;
        market.startTime =
            this.utilService.parseDate(
                marketData?.eventStartTime ??
                marketData?.startDate ??
                marketData?.startDateIso ??
                marketData?.start_time ??
                marketData?.start_date,
            ) ?? market.startTime;
        market.endDate =
            this.utilService.parseDate(
                marketData?.endDate ??
                marketData?.endTime ??
                marketData?.endDateIso ??
                marketData?.end_time ??
                marketData?.end_date,
            ) ?? market.endDate;

        if (marketData?.volume !== undefined && marketData?.volume !== null) {
            market.volume = String(marketData.volume);
        } else if (
            marketData?.volumeNum !== undefined &&
            marketData?.volumeNum !== null
        ) {
            market.volume = String(marketData.volumeNum);
        }

        const tokenIds = this.utilService.parseClobTokenIds(marketData);
        if (tokenIds.length > 0) {
            market.clobTokenIds = tokenIds;
        }

        const { tokenYes, tokenNo } = this.utilService.extractYesNoTokens(
            marketData,
            tokenIds,
        );
        if (tokenYes) market.tokenYes = tokenYes;
        if (tokenNo) market.tokenNo = tokenNo;

        market.type = crypto;

        market.negRisk =
            marketData?.negRisk !== undefined
                ? Boolean(marketData.negRisk)
                : market.negRisk ?? null;
        market.negRiskMarketID =
            marketData?.negRiskMarketID ??
            marketData?.negRiskMarketId ??
            marketData?.neg_risk_market_id ??
            market.negRiskMarketID ??
            null;

        await this.marketRepository.save(market);
    }

    // ============================================================================
    // 2. EXPIRED MARKETS DB CLEANUP (from market.service.ts)
    // ============================================================================

    /**
     * Every 4 minutes - mark expired markets as closed in DB.
     * Also writes expired tokens and groupKeys to Redis for main process
     * to perform in-memory cleanup (unsubscribe WS, cleanup engine cache).
     */
    @Cron('0 */4 * * * *')
    async handleExpiredMarketsCleanup(): Promise<void> {
        this.logger.log('Starting expired markets DB cleanup...');
        try {
            const now = new Date();

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
            const groupKeysToCleanup = new Set<string>();

            for (const market of expiredMarketsToClose) {
                try {
                    // Collect tokens
                    if (market.clobTokenIds && market.clobTokenIds.length > 0) {
                        allExpiredTokens.push(...market.clobTokenIds);
                    }

                    // Compute groupKey (lightweight, pure logic)
                    const groupKey = this.computeGroupKey(market);
                    groupKeysToCleanup.add(groupKey);

                    // Mark closed in DB
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

            // Write expired tokens to Redis for main process to unsubscribe
            const uniqueExpiredTokens = [...new Set(allExpiredTokens)];
            if (uniqueExpiredTokens.length > 0) {
                // Append to existing list (main process consumes and deletes)
                const existingRaw = await this.redisService.get(WORKER_EXPIRED_TOKENS_KEY);
                const existing: string[] = existingRaw ? JSON.parse(existingRaw) : [];
                const merged = [...new Set([...existing, ...uniqueExpiredTokens])];
                await this.redisService.set(
                    WORKER_EXPIRED_TOKENS_KEY,
                    JSON.stringify(merged),
                    2400, // 40 min TTL (2× Main's 20 min interval)
                );
                this.logger.log(
                    `Wrote ${uniqueExpiredTokens.length} expired tokens to Redis`,
                );
            }

            // Write expired groupKeys to Redis for main process to cleanup engine cache
            if (groupKeysToCleanup.size > 0) {
                const groupKeysArray = Array.from(groupKeysToCleanup);
                const existingRaw = await this.redisService.get(WORKER_EXPIRED_GROUP_KEYS_KEY);
                const existing: string[] = existingRaw ? JSON.parse(existingRaw) : [];
                const merged = [...new Set([...existing, ...groupKeysArray])];
                await this.redisService.set(
                    WORKER_EXPIRED_GROUP_KEYS_KEY,
                    JSON.stringify(merged),
                    2400, // 40 min TTL (2× Main's 20 min interval)
                );
                this.logger.log(
                    `Wrote ${groupKeysArray.length} expired groupKeys to Redis`,
                );
            }

            this.logger.log(
                `Expired markets DB cleanup completed. Closed ${expiredMarketsToClose.length} markets`,
            );
        } catch (error) {
            this.logger.error(
                'Error in expired markets DB cleanup:',
                error.message,
            );
        }
    }

    /**
     * Compute groupKey from market — lightweight replica of MarketStructureService.calculateGroupKey
     * Pure logic, no I/O. Uses market.type + market.endDate to produce a deterministic key.
     */
    private computeGroupKey(market: Market): string {
        const symbol = (
            market.type ||
            (market.event as any)?.ticker ||
            (market.event as any)?.slug ||
            market.slug ||
            'unknown'
        ).toLowerCase().replace(/\s+/g, '-');

        const endDate = market.endDate || (market.event as any)?.endDate;
        const endDateKey = endDate
            ? new Date(endDate).toISOString()
            : 'no-end-date';

        return `${symbol}-${endDateKey}`;
    }


    // ============================================================================
    // Utility
    // ============================================================================

    private numFromEnv(key: string, defaultValue: number): number {
        const raw = process.env[key];
        if (!raw) return defaultValue;
        const num = Number(raw);
        return Number.isFinite(num) && num > 0 ? num : defaultValue;
    }

    private boolFromEnv(key: string, defaultValue: boolean): boolean {
        const raw = process.env[key];
        if (!raw) return defaultValue;
        return raw.toLowerCase() === 'true' || raw === '1';
    }
}
