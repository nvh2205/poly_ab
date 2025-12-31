import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Market } from '../../database/entities/market.entity';
import {
  MarketRangeDescriptor,
  RangeBoundary,
  RangeGroup,
  RangeKind,
} from './interfaces/range-group.interface';
import {
  RANGE_GROUP_OVERRIDES,
  RangeGroupOverride,
  RangeOverrideRule,
} from './config/range-group.overrides';

interface ParsedRange {
  bounds: RangeBoundary;
  kind: RangeKind;
  label?: string;
  source: 'question' | 'slug';
}

@Injectable()
export class MarketStructureService {
  private readonly logger = new Logger(MarketStructureService.name);
  private cache = new Map<string, RangeGroup>();

  constructor(
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
  ) {}

  /**
   * Build and cache market groups from DB.
   */
  async rebuild(): Promise<RangeGroup[]> {
    const now = new Date();
    const markets = await this.marketRepository
      .createQueryBuilder('market')
      .leftJoinAndSelect('market.event', 'event')
      .where('market.active = :active', { active: true })
      .andWhere('(market.endDate IS NULL OR market.endDate > :now)', { now })
      .getMany();

    this.logger.log(`Found ${markets.length} active markets with valid end dates`);
    const groups = this.buildGroups(markets);
    this.cache = new Map(groups.map((group) => [group.groupKey, group]));
    this.logger.log(`Rebuilt ${groups.length} market groups`);
    return groups;
  }

  getGroup(groupKey: string): RangeGroup | undefined {
    return this.cache.get(groupKey);
  }

  getAllGroups(): RangeGroup[] {
    return Array.from(this.cache.values());
  }

  private buildGroups(markets: Market[]): RangeGroup[] {
    const grouped = new Map<string, RangeGroup>();

    for (const market of markets) {
      const groupKey = market.event?.slug || market.slug;
      const override = RANGE_GROUP_OVERRIDES[groupKey];
      const { descriptor, appliedOverrides } = this.classifyMarket(
        market,
        override,
      );

      const existing = grouped.get(groupKey);
      const group: RangeGroup =
        existing ||
        ({
          groupKey,
          eventSlug: market.event?.slug,
          eventId: market.eventId,
          crypto: override?.crypto || market.type || market.event?.ticker,
          step: override?.step,
          children: [],
          parents: [],
          unmatched: [],
          overridesApplied: [],
        } as RangeGroup);

      if (descriptor.role === 'child') {
        group.children.push(descriptor);
      } else if (descriptor.role === 'parent') {
        group.parents.push(descriptor);
      } else {
        group.unmatched.push(descriptor);
      }

      group.overridesApplied.push(...appliedOverrides);
      grouped.set(groupKey, group);
    }

    grouped.forEach((group) => {
      group.children.sort(
        (a, b) => (a.bounds.lower ?? 0) - (b.bounds.lower ?? 0),
      );
      if (!group.step) {
        const derivedStep = this.deriveStep(group.children);
        if (derivedStep) {
          group.step = derivedStep;
        }
      }
    });

    return Array.from(grouped.values());
  }

  private classifyMarket(
    market: Market,
    override?: RangeGroupOverride,
  ): { descriptor: MarketRangeDescriptor; appliedOverrides: string[] } {
    const parsed =
      this.parseRange(market.question, 'question') ||
      this.parseRange(market.slug, 'slug');

    const descriptor: MarketRangeDescriptor = {
      marketId: market.marketId,
      slug: market.slug,
      question: market.question,
      clobTokenIds: Array.isArray(market.clobTokenIds)
        ? market.clobTokenIds
        : [],
      type: market.type,
      eventSlug: market.event?.slug,
      eventId: market.eventId,
      bounds: parsed?.bounds || {},
      kind: parsed?.kind || 'unknown',
      label: parsed?.label,
      parsedFrom: parsed?.source,
      role: this.kindToRole(parsed?.kind || 'unknown'),
    };

    const applied: string[] = [];
    if (override?.rules?.length) {
      for (const rule of override.rules) {
        if (this.matchesRule(descriptor, rule)) {
          descriptor.bounds = {
            lower: rule.lower ?? descriptor.bounds.lower,
            upper: rule.upper ?? descriptor.bounds.upper,
          };
          descriptor.kind = rule.kind ?? descriptor.kind;
          descriptor.role = rule.role ?? descriptor.role;
          descriptor.label = rule.label ?? descriptor.label;
          descriptor.parsedFrom = 'override';
          applied.push(
            rule.label ||
              rule.matchSlug ||
              (Array.isArray(rule.slugContains)
                ? rule.slugContains.join(',')
                : rule.slugContains) ||
              (Array.isArray(rule.questionContains)
                ? rule.questionContains.join(',')
                : rule.questionContains) ||
              descriptor.slug,
          );
        }
      }
    }

    return { descriptor, appliedOverrides: applied };
  }

  private parseRange(
    input: string | null,
    source: 'question' | 'slug',
  ): ParsedRange | null {
    if (!input) return null;

    const normalized = input
      .replace(/\$/g, '')
      .replace(/[_]/g, ' ')
      .toLowerCase();
    const tokens = this.extractNumberTokens(normalized);
    const numbers = tokens
      .map((token) => this.parseNumeric(token))
      .filter((num): num is number => Number.isFinite(num));

    if (numbers.length >= 2 && this.containsRangeHint(normalized)) {
      return {
        bounds: { lower: numbers[0], upper: numbers[1] },
        kind: 'range',
        label: `${numbers[0]}-${numbers[1]}`,
        source,
      };
    }

    if (numbers.length >= 1 && this.containsAboveHint(normalized)) {
      return {
        bounds: { lower: numbers[0] },
        kind: 'above',
        label: `>=${numbers[0]}`,
        source,
      };
    }

    if (numbers.length >= 1 && this.containsBelowHint(normalized)) {
      return {
        bounds: { upper: numbers[0] },
        kind: 'below',
        label: `<=${numbers[0]}`,
        source,
      };
    }

    return null;
  }

  private containsRangeHint(text: string): boolean {
    return /(between|to|–|—|-)/.test(text);
  }

  private containsAboveHint(text: string): boolean {
    return /(above|over|greater|>=|gt|at least|\bgreater than\b)/.test(text);
  }

  private containsBelowHint(text: string): boolean {
    return /(below|under|less|<=|lt|at most|\bless than\b)/.test(text);
  }

  private extractNumberTokens(text: string): string[] {
    const matches = text.match(/-?\d+(?:[\.,]\d+)?\s*[kmb]?/gi);
    return matches ? matches.map((m) => m.trim()) : [];
  }

  private parseNumeric(token: string): number | null {
    if (!token) return null;
    const cleaned = token.replace(/,/g, '').trim().toLowerCase();
    const suffix = cleaned.slice(-1);
    let multiplier = 1;

    let core = cleaned;
    if (suffix === 'k') {
      multiplier = 1_000;
      core = cleaned.slice(0, -1);
    } else if (suffix === 'm') {
      multiplier = 1_000_000;
      core = cleaned.slice(0, -1);
    } else if (suffix === 'b') {
      multiplier = 1_000_000_000;
      core = cleaned.slice(0, -1);
    }

    const num = Number.parseFloat(core);
    return Number.isFinite(num) ? num * multiplier : null;
  }

  private kindToRole(kind: RangeKind): MarketRangeDescriptor['role'] {
    if (kind === 'range') return 'child';
    if (kind === 'above' || kind === 'below') return 'parent';
    return 'unknown';
  }

  private matchesRule(
    market: MarketRangeDescriptor,
    rule: RangeOverrideRule,
  ): boolean {
    if (rule.matchSlug && market.slug === rule.matchSlug) return true;

    if (rule.slugContains) {
      const parts = Array.isArray(rule.slugContains)
        ? rule.slugContains
        : [rule.slugContains];
      if (parts.some((part) => market.slug.includes(part))) {
        return true;
      }
    }

    if (rule.questionContains) {
      const question = market.question?.toLowerCase() || '';
      const parts = Array.isArray(rule.questionContains)
        ? rule.questionContains
        : [rule.questionContains];
      if (parts.some((part) => question.includes(part.toLowerCase()))) {
        return true;
      }
    }

    return false;
  }

  private deriveStep(children: MarketRangeDescriptor[]): number | undefined {
    if (children.length < 2) return undefined;
    const diffs: number[] = [];

    for (let i = 1; i < children.length; i++) {
      const prev = children[i - 1];
      const curr = children[i];
      if (
        Number.isFinite(prev.bounds.lower) &&
        Number.isFinite(curr.bounds.lower)
      ) {
        const diff = (curr.bounds.lower as number) - (prev.bounds.lower as number);
        if (diff > 0) {
          diffs.push(diff);
        }
      }
    }

    if (diffs.length === 0) return undefined;
    return Math.min(...diffs);
  }
}

