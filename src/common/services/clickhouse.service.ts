import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, ClickHouseClient } from '@clickhouse/client';

@Injectable()
export class ClickHouseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClickHouseService.name);
  private client: ClickHouseClient;

  constructor(private configService: ConfigService) {
    this.client = createClient({
      host: this.configService.get('CLICKHOUSE_HOST', 'http://localhost:8123'),
      username: this.configService.get('CLICKHOUSE_USER', 'polymarket'),
      password: this.configService.get('CLICKHOUSE_PASSWORD', 'polymarket123'),
      database: this.configService.get('CLICKHOUSE_DATABASE', 'polymarket_db'),
    });
  }

  async onModuleInit() {
    try {
      // Test connection
      await this.client.ping();
      this.logger.log('ClickHouse connected successfully');
    } catch (error) {
      this.logger.error('ClickHouse connection error:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.client.close();
    this.logger.log('ClickHouse connection closed');
  }

  /**
   * Execute a query and return results
   */
  async query<T = unknown>(
    query: string,
    params?: Record<string, any>,
  ): Promise<T[]> {
    try {
      const result = await this.client.query({
        query,
        format: 'JSONEachRow',
        // ClickHouse query parameters for placeholders like `{name:Type}`
        // Ref: @clickhouse/client uses `query_params`
        query_params: params,
      });
      const rows = await result.json<T>();
      return rows as unknown as T[];
    } catch (error) {
      this.logger.error('ClickHouse query error:', error);
      throw error;
    }
  }

  /**
   * Execute a command (INSERT, CREATE, etc.)
   */
  async command(command: string): Promise<void> {
    try {
      await this.client.command({
        query: command,
      });
    } catch (error) {
      this.logger.error('ClickHouse command error:', error);
      throw error;
    }
  }

  /**
   * Insert data into a table
   */
  async insert<T extends Record<string, unknown>>(
    table: string,
    data: T[],
  ): Promise<void> {
    try {
      await this.client.insert({
        table,
        values: data,
        format: 'JSONEachRow',
      });
    } catch (error) {
      this.logger.error(`ClickHouse insert error for table ${table}:`, error);
      throw error;
    }
  }

  /**
   * Get the ClickHouse client instance
   */
  getClient(): ClickHouseClient {
    return this.client;
  }

  /**
   * Check if ClickHouse is available
   */
  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch (error) {
      return false;
    }
  }
}

