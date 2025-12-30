import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { APP_CONSTANTS } from '../constants/app.constants';

@Injectable()
export class PolymarketApiService {
  private readonly logger = new Logger(PolymarketApiService.name);
  private readonly apiUrl: string = APP_CONSTANTS.POLYMARKET_API_URL;
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: 15000,
      headers: {
        'User-Agent': 'PolymarketDataCollector/1.0',
      },
    });
  }

  /**
   * Fetch event by slug
   */
  async fetchEventBySlug(slug: string): Promise<any> {
    const url = `/events/slug/${encodeURIComponent(slug)}`;
    this.logger.debug(`Fetching event: ${url}`);

    try {
      const response = await this.client.get(url);
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        this.logger.warn(`Event not found: ${slug}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Fetch market by slug
   */
  async fetchMarketBySlug(slug: string): Promise<any | null> {
    const url = `/markets?slug=${slug}`;
    this.logger.debug(`Fetching market: ${url}`);

    try {
      const response = await this.client.get(url);
      // API might return array or single object
      const data = Array.isArray(response.data)
        ? response.data[0]
        : response.data;
      return data || null;
    } catch (error) {
      if (error.response?.status === 404) {
        this.logger.warn(`Market not found: ${slug}`);
        return null;
      }
      throw error;
    }
  }
}

