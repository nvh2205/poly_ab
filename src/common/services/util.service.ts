import { Injectable, Logger } from '@nestjs/common';
import { SlugConfig, TimeInterval } from '../constants/app.constants';

@Injectable()
export class UtilService {
  private readonly logger = new Logger(UtilService.name);

  /**
   * Generate slug based on pattern and configuration
   */
  generateSlug(config: SlugConfig): string {
    return this.generateSlugWithOffset(config, 0);
  }

  /**
   * Generate slug with time offset
   * @param config Slug configuration
   * @param offset Number of intervals to offset (0 = current, -1 = previous, -2 = 2 intervals ago, etc.)
   */
  generateSlugWithOffset(config: SlugConfig, offset: number = 0): string {
    switch (config.pattern) {
      case 'timestamp':
        return this.generateTimestampSlugWithOffset(config, offset);
      case 'datetime':
        return this.generateDateTimeSlugWithOffset(config, offset);
      case 'daily':
        return this.generateDailySlugWithOffset(config, offset);
      default:
        throw new Error(`Unknown pattern: ${config.pattern}`);
    }
  }

  /**
   * Generate timestamp-based slug
   * Example: btc-updown-15m-1764612000
   * Logic: timestamp * 1000 > current - interval
   */
  private generateTimestampSlug(config: SlugConfig): string {
    return this.generateTimestampSlugWithOffset(config, 0);
  }

  /**
   * Generate timestamp-based slug with offset
   */
  private generateTimestampSlugWithOffset(
    config: SlugConfig,
    offset: number,
  ): string {
    const now = new Date();
    // Use current interval time (not next) as base when offset = 0
    const baseTime = this.getCurrentIntervalTime(now, config.interval);

    // Apply offset
    const intervalMs = this.getIntervalMs(config.interval);
    const targetTime = new Date(baseTime.getTime() + offset * intervalMs);

    const timestamp = Math.floor(targetTime.getTime() / 1000);
    return `${config.baseSlug}-${timestamp}`;
  }

  /**
   * Generate datetime-based slug
   * Example: bitcoin-up-or-down-december-1-11am-et
   * Uses current hour (rounded to next hour if past 30 minutes)
   */
  private generateDateTimeSlug(config: SlugConfig): string {
    return this.generateDateTimeSlugWithOffset(config, 0);
  }

  /**
   * Generate datetime-based slug with offset
   */
  private generateDateTimeSlugWithOffset(
    config: SlugConfig,
    offset: number,
  ): string {
    const now = new Date();

    // Start from current hour (not next hour)
    const targetTime = new Date(now);
    targetTime.setMinutes(0);
    targetTime.setSeconds(0);
    targetTime.setMilliseconds(0);

    // Apply offset (in hours)
    targetTime.setHours(targetTime.getHours() + offset);

    const monthNames = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ];

    const month = monthNames[targetTime.getMonth()];
    const day = targetTime.getDate();
    const hour = targetTime.getHours();

    // Convert to 12-hour format
    const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    const period = hour >= 12 ? 'pm' : 'am';

    return `${config.baseSlug}-${month}-${day}-${hour12}${period}-et`;
  }

  /**
   * Generate daily slug
   * Example: bitcoin-up-or-down-on-december-1
   */
  private generateDailySlug(config: SlugConfig): string {
    return this.generateDailySlugWithOffset(config, 0);
  }

  /**
   * Generate daily slug with offset
   */
  private generateDailySlugWithOffset(
    config: SlugConfig,
    offset: number,
  ): string {
    const now = new Date();
    // Start from current day at midnight, then apply offset
    const targetTime = new Date(now);
    targetTime.setDate(targetTime.getDate() + offset);
    targetTime.setHours(0, 0, 0, 0);

    const monthNames = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ];

    const month = monthNames[targetTime.getMonth()];
    const day = targetTime.getDate();

    return `${config.baseSlug}-${month}-${day}`;
  }

  /**
   * Calculate current interval time (rounded down) based on interval type
   * Example: if now is 10:07, for 15m interval, returns 10:00
   */
  private getCurrentIntervalTime(now: Date, interval: TimeInterval): Date {
    const targetTime = new Date(now);

    switch (interval) {
      case '15m':
        const minutes15 = now.getMinutes();
        const roundedMinutes15 = Math.floor(minutes15 / 15) * 15;
        targetTime.setMinutes(roundedMinutes15);
        targetTime.setSeconds(0);
        targetTime.setMilliseconds(0);
        break;

      case '1h':
        targetTime.setMinutes(0);
        targetTime.setSeconds(0);
        targetTime.setMilliseconds(0);
        break;

      case '4h':
        const currentHour = targetTime.getHours();
        const currentInterval4h = Math.floor(currentHour / 4) * 4;
        targetTime.setHours(currentInterval4h);
        targetTime.setMinutes(0);
        targetTime.setSeconds(0);
        targetTime.setMilliseconds(0);
        break;

      case 'daily':
        targetTime.setHours(0, 0, 0, 0);
        break;
    }

    return targetTime;
  }

  /**
   * Calculate next interval time based on interval type
   */
  private getNextIntervalTime(now: Date, interval: TimeInterval): Date {
    const targetTime = new Date(now);

    switch (interval) {
      case '15m':
        const minutes15 = now.getMinutes();
        const remainder15 = 15 - (minutes15 % 15);
        targetTime.setMinutes(minutes15 + remainder15);
        targetTime.setSeconds(0);
        targetTime.setMilliseconds(0);
        break;

      case '1h':
        targetTime.setHours(targetTime.getHours() + 1);
        targetTime.setMinutes(0);
        targetTime.setSeconds(0);
        targetTime.setMilliseconds(0);
        break;

      case '4h':
        const currentHour = targetTime.getHours();
        const nextInterval4h = Math.ceil((currentHour + 1) / 4) * 4;
        targetTime.setHours(nextInterval4h);
        targetTime.setMinutes(0);
        targetTime.setSeconds(0);
        targetTime.setMilliseconds(0);
        break;

      case 'daily':
        targetTime.setDate(targetTime.getDate() + 1);
        targetTime.setHours(0, 0, 0, 0);
        break;
    }

    return targetTime;
  }

  /**
   * Check if a slug is still valid (not expired)
   * For timestamp-based: check if timestamp * 1000 > current - interval
   */
  isSlugValid(slug: string, config: SlugConfig): boolean {
    if (config.pattern === 'timestamp') {
      const timestampMatch = slug.match(/-(\d+)$/);
      if (!timestampMatch) return false;

      const slugTimestamp = parseInt(timestampMatch[1], 10);
      const slugTime = slugTimestamp * 1000;
      const now = Date.now();

      // Get interval in milliseconds
      const intervalMs = this.getIntervalMs(config.interval);

      // Check if slug is still valid: slugTime > now - interval
      return slugTime > now - intervalMs;
    }

    // For datetime and daily patterns, we could add more sophisticated validation
    return true;
  }

  /**
   * Get interval in milliseconds
   */
  private getIntervalMs(interval: TimeInterval): number {
    switch (interval) {
      case '15m':
        return 15 * 60 * 1000;
      case '1h':
        return 60 * 60 * 1000;
      case '4h':
        return 4 * 60 * 60 * 1000;
      case 'daily':
        return 24 * 60 * 60 * 1000;
      default:
        return 0;
    }
  }

  /**
   * Generate slug with next 15-minute timestamp (deprecated - use generateSlug)
   * Example: btc-updown-15m-1764518400
   */
  getNext15MinSlug(baseSlug: string): string {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const milliseconds = now.getMilliseconds();

    // Calculate minutes to next 15-minute mark (0, 15, 30, 45)
    const remainder = 15 - (minutes % 15);

    // Create target time by adding the remainder
    const targetTime = new Date(now.getTime());
    targetTime.setMinutes(minutes + remainder);
    targetTime.setSeconds(0);
    targetTime.setMilliseconds(0);

    const timestamp = Math.floor(targetTime.getTime() / 1000);
    return `${baseSlug}-${timestamp}`;
  }

  /**
   * Get current 15-minute slot timestamp
   */
  getCurrentSlugTimestamp(): number {
    const now = new Date();
    const minutes = now.getMinutes();
    const roundedMinutes = Math.floor(minutes / 15) * 15;

    const targetTime = new Date(now.getTime());
    targetTime.setMinutes(roundedMinutes);
    targetTime.setSeconds(0);
    targetTime.setMilliseconds(0);

    return Math.floor(targetTime.getTime() / 1000);
  }

  /**
   * Chunk array into smaller arrays of specified size
   */
  chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Parse CLOB token IDs from API response
   * Handle double-encoded JSON strings
   */
  parseClobTokenIds(data: any): string[] {
    try {
      if (!data || !data.clobTokenIds) {
        return [];
      }

      let tokenIds = data.clobTokenIds;

      // If it's a string, try to parse it
      if (typeof tokenIds === 'string') {
        tokenIds = JSON.parse(tokenIds);
      }

      // If it's still a string after first parse, parse again
      if (typeof tokenIds === 'string') {
        tokenIds = JSON.parse(tokenIds);
      }

      // Ensure it's an array
      if (Array.isArray(tokenIds)) {
        return tokenIds.map(String);
      }

      return [];
    } catch (error) {
      console.error('Error parsing clob token IDs:', error);
      return [];
    }
  }

  /**
   * Sleep for specified milliseconds
   */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Parse date from various formats (string, number, Date)
   * Handles ISO strings, Unix timestamps (seconds or milliseconds), and Date objects
   */
  parseDate(val: any): Date | null {
    if (!val) return null;
    if (val instanceof Date) return val;
    if (typeof val === 'number') {
      const ms = val < 1e12 ? val * 1000 : val;
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (!trimmed) return null;
      if (/^\d+$/.test(trimmed)) {
        const num = Number(trimmed);
        const ms = num < 1e12 ? num * 1000 : num;
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d;
      }
      const d = new Date(trimmed);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  /**
   * Extract YES/NO token IDs from market data
   * Handles various formats: token_yes/tokenYes, tokens array, clobTokenIds fallback
   */
  extractYesNoTokens(
    marketData: Record<string, any>,
    clobTokenIds?: string[],
  ): { tokenYes: string | null; tokenNo: string | null } {
    const normalize = (val: any): string | null => {
      if (!val) return null;
      if (typeof val === 'string') {
        // Attempt JSON parse if it looks like an array/object
        if (
          (val.startsWith('[') && val.endsWith(']')) ||
          (val.startsWith('{') && val.endsWith('}'))
        ) {
          try {
            const parsed = JSON.parse(val);
            return normalize(parsed);
          } catch {
            return val;
          }
        }
        return val;
      }
      if (Array.isArray(val)) {
        return val.length > 0 ? normalize(val[0]) : null;
      }
      if (typeof val === 'object') {
        return (
          (val as any).token_id ||
          (val as any).tokenId ||
          (val as any).tokenID ||
          (val as any).id ||
          null
        );
      }
      return String(val);
    };

    let tokenYes =
      normalize(marketData.token_yes) ||
      normalize(marketData.tokenYes) ||
      normalize((marketData as any).token_yes) ||
      normalize((marketData as any).tokenYes);

    let tokenNo =
      normalize(marketData.token_no) ||
      normalize(marketData.tokenNo) ||
      normalize((marketData as any).token_no) ||
      normalize((marketData as any).tokenNo);

    const tokens = Array.isArray(marketData.tokens) ? marketData.tokens : [];

    for (const token of tokens) {
      if (!token || !token.outcome) continue;

      const outcome = String(token.outcome).toLowerCase();
      const tokenId =
        (token as any).token_id ||
        (token as any).tokenId ||
        (token as any).tokenID ||
        (token as any).id;

      if (outcome === 'yes' && !tokenYes && tokenId) {
        tokenYes = tokenId;
      } else if (outcome === 'no' && !tokenNo && tokenId) {
        tokenNo = tokenId;
      }

      if (tokenYes && tokenNo) {
        break;
      }
    }

    // If token_yes was an array with two entries, use second as no
    if (!tokenNo) {
      const rawYes =
        marketData.token_yes ||
        marketData.tokenYes ||
        (marketData as any).token_yes ||
        (marketData as any).tokenYes;
      if (Array.isArray(rawYes) && rawYes.length > 1) {
        tokenNo = normalize(rawYes[1]);
      } else if (typeof rawYes === 'string') {
        try {
          const parsed = JSON.parse(rawYes);
          if (Array.isArray(parsed) && parsed.length > 1) {
            tokenNo = normalize(parsed[1]);
          }
        } catch {
          // ignore
        }
      }
    }

    // Fallback: if still missing, try the first two clob token ids in order
    if ((!tokenYes || !tokenNo) && Array.isArray(clobTokenIds)) {
      if (!tokenYes && clobTokenIds.length > 0) {
        tokenYes = normalize(clobTokenIds[0]);
      }
      if (!tokenNo && clobTokenIds.length > 1) {
        tokenNo = normalize(clobTokenIds[1]);
      }
    }

    return {
      tokenYes: tokenYes || null,
      tokenNo: tokenNo || null,
    };
  }
}
