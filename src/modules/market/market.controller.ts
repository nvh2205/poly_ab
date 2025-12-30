import {
  Controller,
  Get,
  Post,
  Query,
  Delete,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiOkResponse,
} from '@nestjs/swagger';
import { MarketService } from './market.service';
import { RedisService } from '../../common/services/redis.service';

@ApiTags('market')
@Controller('market')
export class MarketController {
  private readonly logger = new Logger(MarketController.name);

  constructor(
    private readonly marketService: MarketService,
    private readonly redisService: RedisService,
  ) {}

  @Get('active-tokens')
  @ApiOperation({ summary: 'Get all active token IDs' })
  @ApiOkResponse({
    description: 'List of active token IDs',
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number', example: 10 },
        tokens: {
          type: 'array',
          items: { type: 'string' },
          example: ['token1', 'token2', 'token3'],
        },
      },
    },
  })
  async getActiveTokens() {
    const tokens = await this.marketService.getActiveTokens();
    return {
      count: tokens.length,
      tokens,
    };
  }

  @Get('active-tokens-metadata')
  @ApiOperation({ summary: 'Get active tokens with metadata' })
  @ApiOkResponse({
    description: 'List of active tokens with discovery metadata',
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number', example: 10 },
        tokens: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tokenId: { type: 'string' },
              slug: { type: 'string' },
              crypto: { type: 'string' },
              interval: { type: 'string' },
              pattern: { type: 'string' },
              discoveredAt: { type: 'number' },
            },
          },
        },
      },
    },
  })
  async getActiveTokensWithMetadata() {
    const tokens = await this.marketService.getActiveTokensWithMetadata();
    return {
      count: tokens.length,
      tokens,
    };
  }

  @Get('current-slugs')
  @ApiOperation({ summary: 'Get all current slug patterns' })
  @ApiOkResponse({
    description: 'List of current slug patterns that would be generated',
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number', example: 15 },
        slugs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              crypto: { type: 'string', example: 'btc' },
              interval: { type: 'string', example: '15m' },
              pattern: { type: 'string', example: 'timestamp' },
              slug: { type: 'string', example: 'btc-updown-15m-1764604800' },
            },
          },
        },
      },
    },
  })
  async getCurrentSlugs() {
    const slugs = await this.marketService.getAllCurrentSlugs();
    return {
      count: slugs.length,
      slugs,
    };
  }


  @Delete('redis/clear')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear all Redis data',
    description:
      'WARNING: This will delete ALL data in Redis including active tokens, market info, and token metadata',
  })
  @ApiOkResponse({
    description: 'All Redis data cleared successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'All Redis data has been cleared' },
        keysDeleted: { type: 'number', example: 150 },
        timestamp: { type: 'string', example: '2024-01-01T00:00:00.000Z' },
      },
    },
  })
  async clearRedis() {
    const totalKeys = await this.redisService.getTotalKeys();
    await this.redisService.flushAll();
    return {
      message: 'All Redis data has been cleared',
      keysDeleted: totalKeys,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('redis/stats')
  @ApiOperation({ summary: 'Get Redis statistics' })
  @ApiOkResponse({
    description: 'Redis statistics including key counts and active tokens',
    schema: {
      type: 'object',
      properties: {
        totalKeys: { type: 'number', example: 150 },
        activeTokens: {
          type: 'object',
          properties: {
            count: { type: 'number', example: 10 },
            tokens: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        marketInfo: {
          type: 'object',
          properties: {
            count: { type: 'number', example: 50 },
          },
        },
        tokenMetadata: {
          type: 'object',
          properties: {
            count: { type: 'number', example: 10 },
          },
        },
        timestamp: { type: 'string', example: '2024-01-01T00:00:00.000Z' },
      },
    },
  })
  async getRedisStats() {
    const totalKeys = await this.redisService.getTotalKeys();
    const activeTokens = await this.redisService.smembers('active_clob_tokens');

    // Get all keys matching common patterns
    const marketInfoKeys = await this.redisService.keys('market_info:*');
    const tokenMetadataKeys = await this.redisService.keys('token_metadata:*');

    return {
      totalKeys,
      activeTokens: {
        count: activeTokens.length,
        tokens: activeTokens,
      },
      marketInfo: {
        count: marketInfoKeys.length,
      },
      tokenMetadata: {
        count: tokenMetadataKeys.length,
      },
      timestamp: new Date().toISOString(),
    };
  }

}
