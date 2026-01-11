import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  APP_CONSTANTS,
  SlugConfig,
} from '../../common/constants/app.constants';
import { UtilService } from '../../common/services/util.service';
import { PolymarketApiService } from '../../common/services/polymarket-api.service';
import { Event, Market } from '../../database/entities';

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

@Injectable()
export class EventCrawlerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventCrawlerService.name);
  private readonly eventSlugConfigs: SlugConfig[] =
    APP_CONSTANTS.EVENT_SLUG_CONFIGS;

  constructor(
    private readonly utilService: UtilService,
    private readonly polymarketApi: PolymarketApiService,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('EventCrawlerService initialized');
    await this.crawlEventsEvery4Hours();
  }

  /**
   * Run every 1 hour at 00 minutes 00 seconds
   */
  @Cron('0 0 * * * *')
  async crawlEventsEvery4Hours(): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(
      `Starting event crawl (every 4h), configs=${this.eventSlugConfigs.length}`,
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

  /**
   * Find crypto value from slug by matching against EVENT_SLUG_CONFIGS
   */
  private findCryptoFromSlug(slug: string): string | null {
    for (const config of this.eventSlugConfigs) {
      // For daily patterns, slug starts with baseSlug (e.g., 'bitcoin-above-on-december-29' starts with 'bitcoin-above-on')
      if (config.pattern === 'daily' && slug.startsWith(config.baseSlug)) {
        return config.crypto;
      }
      // For timestamp patterns, slug format is baseSlug-timestamp (e.g., 'btc-updown-15m-1764612000')
      if (
        config.pattern === 'timestamp' &&
        slug.startsWith(config.baseSlug + '-')
      ) {
        return config.crypto;
      }
      // For datetime patterns, slug format is baseSlug-datetime (e.g., 'bitcoin-up-or-down-december-1-11am-et')
      if (
        config.pattern === 'datetime' &&
        slug.startsWith(config.baseSlug + '-')
      ) {
        return config.crypto;
      }
    }
    return null;
  }

  async fetchAndSaveEventBySlug(slug: string, crypto?: string): Promise<Event> {
    // If crypto not provided, try to find it from slug
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
      where: [...(marketId ? [{ marketId }] : []), ...(slug ? [{ slug }] : [])],
    });

    const market = existing || this.marketRepository.create();

    // Set identifiers
    if (marketId) market.marketId = marketId;
    if (slug) market.slug = slug;
    market.event = event;

    // Set basic fields
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

    // Set status flags
    market.active =
      marketData?.active !== undefined
        ? Boolean(marketData.active)
        : (market.active ?? true);
    market.closed =
      marketData?.closed !== undefined
        ? Boolean(marketData.closed)
        : (market.closed ?? false);

    // Set dates
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

    // Set volume
    if (marketData?.volume !== undefined && marketData?.volume !== null) {
      market.volume = String(marketData.volume);
    } else if (
      marketData?.volumeNum !== undefined &&
      marketData?.volumeNum !== null
    ) {
      market.volume = String(marketData.volumeNum);
    }

    // Set token IDs
    const tokenIds = this.utilService.parseClobTokenIds(marketData);
    if (tokenIds.length > 0) {
      market.clobTokenIds = tokenIds;
    }

    // Extract and set YES/NO tokens
    const { tokenYes, tokenNo } = this.utilService.extractYesNoTokens(
      marketData,
      tokenIds,
    );
    if (tokenYes) market.tokenYes = tokenYes;
    if (tokenNo) market.tokenNo = tokenNo;

    // Set type from crypto config
    market.type = crypto;

    await this.marketRepository.save(market);
  }
}
