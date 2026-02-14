import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Market } from '../../database/entities/market.entity';
import {
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody
} from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PolymarketOnchainService } from './polymarket-onchain.service';
import type {
  PolymarketConfig,
  OrderParams,
  MarketCondition,
  BatchOrderParams,
} from './polymarket-onchain.service';

/**
 * Polymarket configuration DTO
 */
export class PolymarketConfigDto implements PolymarketConfig {
  @ApiProperty({ example: 'https://polygon-rpc.com' })
  @IsString()
  polygonRpc: string;

  @ApiProperty({ example: 137 })
  @IsNumber()
  chainId: number;

  @ApiProperty({ example: 'https://clob.polymarket.com' })
  @IsString()
  clobUrl: string;

  @ApiProperty({ example: '0xabc...' })
  @IsString()
  privateKey: string;

  @ApiPropertyOptional({ example: 'my-api-key' })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiPropertyOptional({ example: 'my-api-secret' })
  @IsOptional()
  @IsString()
  apiSecret?: string;

  @ApiPropertyOptional({ example: 'my-passphrase' })
  @IsOptional()
  @IsString()
  apiPassphrase?: string;

  @ApiProperty({
    example: '0xb9b5cde0d64a06f5315be41a3ef2bbb530990fa5',
  })
  @IsString()
  proxyAddress: string;
}

/**
 * Order params DTO
 */
export class OrderParamsDto implements OrderParams {
  @ApiProperty({ example: '0x123-token-id' })
  @IsString()
  tokenID: string;

  @ApiProperty({ example: 0.45, description: 'Price in USDC' })
  @IsNumber()
  price: number;

  @ApiProperty({ example: 10, description: 'Size in YES/NO units' })
  @IsNumber()
  size: number;

  @ApiProperty({ enum: ['BUY', 'SELL'] })
  @IsString()
  @IsIn(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';

  @ApiPropertyOptional({ example: 5, description: 'Fee rate in bps' })
  @IsOptional()
  @IsNumber()
  feeRateBps?: number;
}

/**
 * Batch order params DTO
 */
export class BatchOrderParamsDto implements BatchOrderParams {
  @ApiProperty({ example: '0x123-token-id' })
  @IsString()
  tokenID: string;

  @ApiProperty({ example: 0.45, description: 'Price in USDC' })
  @IsNumber()
  price: number;

  @ApiProperty({ example: 10, description: 'Size in YES/NO units' })
  @IsNumber()
  size: number;

  @ApiProperty({ enum: ['BUY', 'SELL'] })
  @IsString()
  @IsIn(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';

  @ApiPropertyOptional({ example: 5, description: 'Fee rate in bps' })
  @IsOptional()
  @IsNumber()
  feeRateBps?: number;

  @ApiPropertyOptional({ enum: ['GTC', 'GTD', 'FOK', 'FAK'] })
  @IsOptional()
  @IsString()
  orderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK';

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  postOnly?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Whether this is a NegRisk market (uses different exchange contract)',
  })
  @IsOptional()
  @IsBoolean()
  negRisk?: boolean;
}

/**
 * Market condition DTO
 */
export class MarketConditionDto implements MarketCondition {
  @ApiProperty({ example: '0xcondition-id' })
  @IsString()
  conditionId: string;

  @ApiPropertyOptional({ example: '0xparent-collection-id' })
  @IsOptional()
  @IsString()
  parentCollectionId?: string;

  @ApiPropertyOptional({
    type: [Number],
    example: [0, 1],
    description: 'Partition indices',
  })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  partition?: number[];

  @ApiPropertyOptional({
    example: false,
    description: 'Whether this is a NegRisk market',
  })
  @IsOptional()
  @IsBoolean()
  negRisk?: boolean;

  @ApiPropertyOptional({
    example: '0xnegrisk-market-id',
    description: 'Group ID for NegRisk adapter (required if negRisk is true)',
  })
  @IsOptional()
  @IsString()
  negRiskMarketID?: string;
}

/**
 * DTO for placing orders
 */
export class PlaceOrderDto {
  @ApiProperty({ type: PolymarketConfigDto })
  @ValidateNested()
  @Type(() => PolymarketConfigDto)
  config: PolymarketConfigDto;

  @ApiProperty({ type: OrderParamsDto })
  @ValidateNested()
  @Type(() => OrderParamsDto)
  order: OrderParamsDto;
}

/**
 * DTO for placing batch orders
 */
export class PlaceBatchOrdersDto {
  @ApiPropertyOptional({ type: PolymarketConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PolymarketConfigDto)
  config?: PolymarketConfigDto;

  @ApiProperty({ type: [BatchOrderParamsDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchOrderParamsDto)
  orders: BatchOrderParamsDto[];
}

/**
 * DTO for mint operations
 */
export class MintTokensDto {
  @ApiProperty({ type: PolymarketConfigDto })
  @ValidateNested()
  @Type(() => PolymarketConfigDto)
  config: PolymarketConfigDto;

  @ApiProperty({ type: MarketConditionDto })
  @ValidateNested()
  @Type(() => MarketConditionDto)
  marketCondition: MarketConditionDto;

  @ApiProperty({ example: 100, description: 'Amount in USDC' })
  @IsNumber()
  amountUSDC: number;

  @ApiProperty({
    example: 'btc-2026-01-11T17:00:00.000Z',
    description: 'Arbitrage group key for inventory',
  })
  @IsString()
  groupKey: string;
}

export class MintTokensProxyDto {
  @ApiProperty({ type: PolymarketConfigDto })
  @ValidateNested()
  @Type(() => PolymarketConfigDto)
  config: PolymarketConfigDto;

  @ApiProperty({ type: MarketConditionDto })
  @ValidateNested()
  @Type(() => MarketConditionDto)
  marketCondition: MarketConditionDto;

  @ApiProperty({ example: 100, description: 'Amount in USDC' })
  @IsNumber()
  amountUSDC: number;

  @ApiProperty({
    example: 'btc-2026-01-11T17:00:00.000Z',
    description: 'Arbitrage group key for inventory',
  })
  @IsString()
  groupKey: string;
}

/**
 * Simplified DTO for mint-proxy operations (query database for market details)
 */
export class MintTokensProxySimpleDto {
  @ApiProperty({
    example: 'will-bitcoin-btc-hit-120000-on-january-21',
    description: 'Market slug to query from database',
  })
  @IsString()
  marketSlug: string;

  @ApiProperty({ example: 100, description: 'Amount in USDC to mint' })
  @IsNumber()
  amountUSDC: number;
}

/**
 * DTO for minting list of markets
 */
export class MintTokensListDto {
  @ApiProperty({
    type: [String],
    description: 'List of market slugs',
    example: ['market-slug-1', 'market-slug-2'],
  })
  @IsArray()
  @IsString({ each: true })
  slugs: string[];

  @ApiProperty({ example: 100, description: 'Amount in USDC to mint for each market' })
  @IsNumber()
  amountUSDC: number;
}

/**
 * DTO for merge operations
 */
export class MergePositionsDto {
  @ApiProperty({ type: PolymarketConfigDto })
  @ValidateNested()
  @Type(() => PolymarketConfigDto)
  config: PolymarketConfigDto;

  @ApiProperty({ type: MarketConditionDto })
  @ValidateNested()
  @Type(() => MarketConditionDto)
  marketCondition: MarketConditionDto;

  @ApiPropertyOptional({ example: 50, description: 'Amount in USDC' })
  @IsOptional()
  @IsNumber()
  amount?: number;
}

/**
 * DTO for redeem operations
 */
export class RedeemPositionsDto {
  @ApiProperty({ type: PolymarketConfigDto })
  @ValidateNested()
  @Type(() => PolymarketConfigDto)
  config: PolymarketConfigDto;

  @ApiProperty({ type: MarketConditionDto })
  @ValidateNested()
  @Type(() => MarketConditionDto)
  marketCondition: MarketConditionDto;
}

/**
 * DTO for balance queries
 */
export class GetBalancesDto {
  @ApiProperty({ type: PolymarketConfigDto })
  @ValidateNested()
  @Type(() => PolymarketConfigDto)
  config: PolymarketConfigDto;

  @ApiPropertyOptional({ example: '0xcondition-id' })
  @IsOptional()
  @IsString()
  conditionId?: string;
}

/**
 * DTO for cancel orders
 */
export class CancelOrdersDto {
  @ApiProperty({ type: PolymarketConfigDto })
  @ValidateNested()
  @Type(() => PolymarketConfigDto)
  config: PolymarketConfigDto;

  @ApiPropertyOptional({ example: '0x123-token-id' })
  @IsOptional()
  @IsString()
  tokenID?: string;
}

/**
 * DTO for Redis data item
 */
export class RedisDataItemDto {
  @ApiProperty({
    example: 'mint:inventory:btc-2026-01-22:0x123...',
    description: 'Redis key',
  })
  @IsString()
  key: string;

  @ApiProperty({
    example: 'hash',
    enum: ['string', 'hash', 'list', 'set', 'zset'],
    description: 'Redis data type',
  })
  @IsString()
  @IsIn(['string', 'hash', 'list', 'set', 'zset'])
  type: string;

  @ApiProperty({
    example: { token1: '100.5', token2: '200.3' },
    description: 'Redis value (format depends on type)',
  })
  value: any;

  @ApiPropertyOptional({
    example: 3600,
    description: 'TTL in seconds',
  })
  @IsOptional()
  @IsNumber()
  ttl?: number;
}

/**
 * DTO for importing Redis data
 */
export class ImportRedisDataDto {
  @ApiProperty({
    type: [RedisDataItemDto],
    description: 'Array of Redis data items to import',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RedisDataItemDto)
  data: RedisDataItemDto[];
}

/**
 * Controller for Polymarket on-chain operations
 */
@ApiTags('polymarket-onchain')
@Controller('polymarket-onchain')
export class PolymarketOnchainController {
  private readonly logger = new Logger(PolymarketOnchainController.name);
  private rustCore: any = null;

  constructor(
    private readonly polymarketOnchainService: PolymarketOnchainService,
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
  ) {
    // Try to load rust-core module
    try {
      const path = require('path');
      this.rustCore = require(path.join(process.cwd(), 'rust-core'));
    } catch {
      // Rust core not available — placeBatchOrdersRust endpoint will return error
    }
  }

  /**
   * POST /polymarket-onchain/place-order
   * Place a limit order on Polymarket
   */
  @Post('place-order')
  async placeOrder(@Body() dto: PlaceOrderDto) {
    try {
      this.logger.log('Received place order request');
      const config = this.polymarketOnchainService.getDefaultConfig();
      if (!config) {
        throw new HttpException(
          'Polymarket config not found',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      const result = await this.polymarketOnchainService.placeLimitOrder(
        config,
        dto.order,
      );

      if (!result.success) {
        throw new HttpException(
          result.error || 'Order placement failed',
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        success: true,
        orderID: result.orderID,
        message: 'Order placed successfully',
      };
    } catch (error: any) {
      this.logger.error(`Error in placeOrder: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /polymarket-onchain/place-batch-orders
   * Place multiple orders in a single batch request (max 15 orders)
   * Reference: https://docs.polymarket.com/developers/CLOB/orders/create-order-batch
   */
  @Post('place-batch-orders')
  async placeBatchOrders(@Body() dto: PlaceBatchOrdersDto) {
    try {
      this.logger.log(
        `Received batch order request for ${dto.orders.length} orders`,
      );

      const config =
        dto.config || this.polymarketOnchainService.getDefaultConfig();
      if (!config) {
        throw new HttpException(
          'Polymarket config not found',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Validate batch size
      if (dto.orders.length > 15) {
        throw new HttpException(
          'Maximum 15 orders allowed per batch',
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.polymarketOnchainService.placeBatchOrders(
        config,
        dto.orders,
      );

      if (!result.success) {
        throw new HttpException(
          result.error || 'Batch order placement failed',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Count successes and failures
      const successCount = result.results?.filter((r) => r.success).length || 0;
      const failureCount =
        result.results?.filter((r) => !r.success).length || 0;

      return {
        success: true,
        totalOrders: dto.orders.length,
        successCount,
        failureCount,
        results: result.results,
        message: `Batch order complete: ${successCount} successful, ${failureCount} failed`,
      };
    } catch (error: any) {
      this.logger.error(`Error in placeBatchOrders: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /polymarket-onchain/place-batch-orders-rust
   * Place multiple orders using Rust Core (signer + HTTP client).
   * Uses the executor's cached wallet and persistent HTTP client for HFT performance.
   * Requires executor to be initialized via RUN_MODE=rust or initExecutor().
   * Reference: https://docs.polymarket.com/developers/CLOB/orders/create-order-batch
   */
  @Post('place-batch-orders-rust')
  async placeBatchOrdersRust(@Body() dto: PlaceBatchOrdersDto) {
    try {
      this.logger.log(
        `[RUST] Received batch order request for ${dto.orders.length} orders`,
      );

      if (!this.rustCore) {
        throw new HttpException(
          'Rust core module not available. Build rust-core first.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Validate batch size
      if (dto.orders.length > 15) {
        throw new HttpException(
          'Maximum 15 orders allowed per batch',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Auto-detect negRisk from CLOB API for each tokenID (critical for EIP-712 signing)
      const tokenIds = dto.orders.map((o) => o.tokenID);
      const [negRiskMap, creds] = await Promise.all([
        this.polymarketOnchainService.resolveNegRiskBatch(tokenIds),
        this.polymarketOnchainService.getApiCredentials(),
      ]);

      // Convert DTO orders to Rust N-API input format (using auto-detected negRisk)
      const rustOrders = dto.orders.map((order) => {
        const autoNegRisk = negRiskMap.get(order.tokenID) ?? order.negRisk ?? false;
        if (order.negRisk !== undefined && order.negRisk !== autoNegRisk) {
          this.logger.warn(
            `[RUST] negRisk mismatch for token ${order.tokenID.slice(0, 20)}...: caller=${order.negRisk}, API=${autoNegRisk}. Using API value.`,
          );
        }
        return {
          tokenId: order.tokenID,
          price: order.price,
          size: order.size,
          side: order.side,
          feeRateBps: order.feeRateBps ?? 0,
          negRisk: autoNegRisk,
          orderType: order.orderType ?? 'GTC',
        };
      });

      // Call Rust Core — sign + post in one shot
      const result = this.rustCore.placeBatchOrdersRust(
        {
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
          signerAddress: creds.signerAddress,
        },
        rustOrders,
      );

      if (!result.success) {
        throw new HttpException(
          result.error || 'Batch order placement failed',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Count successes and failures
      const successCount = result.results?.filter((r: any) => r.success).length || 0;
      const failureCount = result.results?.filter((r: any) => !r.success).length || 0;

      return {
        success: true,
        totalOrders: dto.orders.length,
        successCount,
        failureCount,
        results: result.results,
        latencyMs: result.latencyMs,
        message: `[RUST] Batch order complete: ${successCount} successful, ${failureCount} failed in ${result.latencyMs?.toFixed(1)}ms`,
      };
    } catch (error: any) {
      this.logger.error(`Error in placeBatchOrdersRust: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('place-batch-orders-native')
  async placeBatchOrdersNative(@Body() dto: PlaceBatchOrdersDto) {
    try {
      this.logger.log(
        `Received batch order request for ${dto.orders.length} orders`,
      );

      const config =
        dto.config || this.polymarketOnchainService.getDefaultConfig();
      if (!config) {
        throw new HttpException(
          'Polymarket config not found',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Validate batch size
      if (dto.orders.length > 15) {
        throw new HttpException(
          'Maximum 15 orders allowed per batch',
          HttpStatus.BAD_REQUEST,
        );
      }
      // Auto-detect negRisk from CLOB API for each tokenID (critical for EIP-712 signing)
      const tokenIds = dto.orders.map((o) => o.tokenID);
      const negRiskMap = await this.polymarketOnchainService.resolveNegRiskBatch(tokenIds);

      // Override negRisk with auto-detected values
      const ordersWithNegRisk = dto.orders.map((order) => {
        const autoNegRisk = negRiskMap.get(order.tokenID) ?? order.negRisk ?? false;
        if (order.negRisk !== undefined && order.negRisk !== autoNegRisk) {
          this.logger.warn(
            `negRisk mismatch for token ${order.tokenID.slice(0, 20)}...: caller=${order.negRisk}, API=${autoNegRisk}. Using API value.`,
          );
        }
        return { ...order, negRisk: autoNegRisk };
      });

      const result = await this.polymarketOnchainService.placeBatchOrdersAxios(
        config,
        ordersWithNegRisk,
      );

      if (!result.success) {
        throw new HttpException(
          result.error || 'Batch order placement failed',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Count successes and failures
      const successCount = result.results?.filter((r) => r.success).length || 0;
      const failureCount =
        result.results?.filter((r) => !r.success).length || 0;

      return {
        success: true,
        totalOrders: dto.orders.length,
        successCount,
        failureCount,
        results: result.results,
        message: `Batch order complete: ${successCount} successful, ${failureCount} failed`,
      };
    } catch (error: any) {
      this.logger.error(`Error in placeBatchOrders: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /polymarket-onchain/create-order-only
   * Create orders without posting them to the exchange
   * Saves each order to a JSON file organized by tokenID
   */
  @Post('create-order-only')
  @ApiOperation({
    summary: 'Create orders without posting (for debugging/testing)',
    description:
      'Creates signed orders without posting them to the exchange. Each order is saved to a JSON file at data/orders/{tokenID}.json',
  })
  async createOrderOnly(@Body() dto: PlaceBatchOrdersDto) {
    try {
      this.logger.log(
        `Received create-order-only request for ${dto.orders.length} orders`,
      );

      const config =
        dto.config || this.polymarketOnchainService.getDefaultConfig();
      if (!config) {
        throw new HttpException(
          'Polymarket config not found',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      const result = await this.polymarketOnchainService.createOrderOnly(
        config,
        dto.orders,
      );

      if (!result.success) {
        throw new HttpException(
          result.error || 'Create order failed',
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        success: true,
        totalOrders: dto.orders.length,
        orders: result.orders,
        message: `Created ${dto.orders.length} orders without posting. Each order saved to JSON file by tokenID.`,
      };
    } catch (error: any) {
      this.logger.error(`Error in createOrderOnly: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /polymarket-onchain/mint
   * Mint tokens by splitting USDC into YES/NO positions
   */
  @Post('mint')
  async mintTokens(@Body() dto: MintTokensDto) {
    try {
      this.logger.log(`Received mint request for ${dto.amountUSDC} USDC`);
      const config = this.polymarketOnchainService.getDefaultConfig();
      if (!config) {
        throw new HttpException(
          'Polymarket config not found',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      const result = await this.polymarketOnchainService.mintTokens(
        config,
        dto.marketCondition,
        dto.amountUSDC,
        dto.groupKey,
      );

      if (!result.success) {
        throw new HttpException(
          result.error || 'Mint operation failed',
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        success: true,
        txHash: result.txHash,
        transferTxHash: result.transferTxHash,
        message: 'Tokens minted successfully',
      };
    } catch (error: any) {
      this.logger.error(`Error in mintTokens: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /polymarket-onchain/mint-proxy
   * Mint tokens via proxy (Gnosis Safe)
   */
  @Post('mint-proxy')
  async mintTokensProxy(@Body() dto: MintTokensProxySimpleDto) {
    try {
      this.logger.log(
        `Received mint-proxy request for ${dto.amountUSDC} USDC, marketSlug=${dto.marketSlug}`,
      );

      // Query market from database by slug
      const market = await this.marketRepository.findOne({
        where: { slug: dto.marketSlug },
      });

      if (!market) {
        throw new HttpException(
          `Market not found for slug: ${dto.marketSlug}`,
          HttpStatus.NOT_FOUND,
        );
      }

      // Validate required fields
      if (!market.conditionId) {
        throw new HttpException(
          `Market ${dto.marketSlug} does not have a conditionId`,
          HttpStatus.BAD_REQUEST,
        );
      }

      if (!market.endDate) {
        throw new HttpException(
          `Market ${dto.marketSlug} does not have an endDate`,
          HttpStatus.BAD_REQUEST,
        );
      }

      if (!market.type) {
        throw new HttpException(
          `Market ${dto.marketSlug} does not have a type`,
          HttpStatus.BAD_REQUEST,
        );
      }

      // Build groupKey from type and endDate in UTC format
      // Format: {type}-{endDate.toISOString()} e.g., "btc-2026-01-21T17:00:00.000Z"
      const endDateUtc = new Date(market.endDate).toISOString();
      const groupKey = `${market.type}-${endDateUtc}`;

      // Build marketCondition from market entity
      const marketCondition: MarketCondition = {
        conditionId: market.conditionId,
        negRisk: market.negRisk ?? false,
        negRiskMarketID: market.negRiskMarketID ?? undefined,
      };

      this.logger.log(
        `Resolved market: conditionId=${market.conditionId}, negRisk=${market.negRisk}, groupKey=${groupKey}`,
      );

      const config = this.polymarketOnchainService.getDefaultConfig();
      if (!config) {
        throw new HttpException(
          'Polymarket config not found',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }


      const result = await this.polymarketOnchainService.mintTokensViaProxy(
        config,
        marketCondition,
        dto.amountUSDC,
        groupKey,
      );

      if (!result.success) {
        throw new HttpException(
          result.error || 'Mint-proxy operation failed',
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        success: true,
        txHash: result.txHash,
        groupKey,
        conditionId: market.conditionId,
        message: 'Tokens minted via proxy successfully',
      };
    } catch (error: any) {
      this.logger.error(`Error in mintTokensProxy: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /polymarket-onchain/mint-proxy-list
   * Mint tokens for list of market slugs via proxy (Gnosis Safe)
   * Fire and Forget: Returns immediately, processes in background
   */
  @Post('mint-proxy-list')
  async mintTokensProxyList(@Body() dto: MintTokensListDto) {
    this.logger.log(
      `Received mint-proxy-list request for ${dto.slugs.length} markets, amount=${dto.amountUSDC}`,
    );

    // Fire and forget - process in background
    this.processMintList(dto.slugs, dto.amountUSDC).catch((err) => {
      this.logger.error(`Error in background mint process: ${err.message}`);
    });

    return {
      success: true,
      message: `Started minting for ${dto.slugs.length} markets in background`,
    };
  }

  private async processMintList(slugs: string[], amountUSDC: number) {
    for (const slug of slugs) {
      try {
        // Sleep 200ms to avoid rate limit
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Query market from database by slug
        const market = await this.marketRepository.findOne({
          where: { slug: slug },
        });

        if (!market) {
          this.logger.warn(`processMintList: Market not found for slug: ${slug}`);
          continue;
        }

        // Validate required fields
        if (!market.conditionId) {
          this.logger.warn(
            `processMintList: Market ${slug} does not have a conditionId`,
          );
          continue;
        }

        if (!market.endDate) {
          this.logger.warn(
            `processMintList: Market ${slug} does not have an endDate`,
          );
          continue;
        }

        if (!market.type) {
          this.logger.warn(
            `processMintList: Market ${slug} does not have a type`,
          );
          continue;
        }

        // Build groupKey
        const endDateUtc = new Date(market.endDate).toISOString();
        const groupKey = `${market.type}-${endDateUtc}`;

        // Build marketCondition
        const marketCondition: MarketCondition = {
          conditionId: market.conditionId,
          negRisk: market.negRisk ?? false,
          negRiskMarketID: market.negRiskMarketID ?? undefined,
        };

        const config = this.polymarketOnchainService.getDefaultConfig();
        if (!config) {
          this.logger.error('processMintList: Polymarket config not found');
          return; // Stop processing if config is missing
        }

        this.logger.log(
          `Minting for ${slug} (conditionId=${market.conditionId}, groupKey=${groupKey})...`,
        );

        const result = await this.polymarketOnchainService.mintTokensViaProxy(
          config,
          marketCondition,
          amountUSDC,
          groupKey,
        );

        if (result.success) {
          this.logger.log(
            `✅ Successfully minted for ${slug}, tx: ${result.txHash}`,
          );
        } else {
          this.logger.error(
            `❌ Failed to mint for ${slug}: ${result.error || 'Unknown error'}`,
          );
        }
      } catch (error: any) {
        this.logger.error(
          `Error processing mint for ${slug}: ${error.message}`,
        );
      }
    }
  }

  /**
   * POST /polymarket-onchain/merge
   * Merge YES + NO positions back to USDC
   */
  @Post('merge')
  async mergePositions(@Body() dto: MergePositionsDto) {
    try {
      this.logger.log('Received merge positions request');
      const config = this.polymarketOnchainService.getDefaultConfig();
      if (!config) {
        throw new HttpException(
          'Polymarket config not found',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      const result = await this.polymarketOnchainService.mergePositions(
        config,
        dto.marketCondition,
        dto.amount,
      );

      if (!result.success) {
        throw new HttpException(
          result.error || 'Merge operation failed',
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        success: true,
        txHash: result.txHash,
        amountMerged: result.amountMerged,
        message: 'Positions merged successfully',
      };
    } catch (error: any) {
      this.logger.error(`Error in mergePositions: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /polymarket-onchain/redeem
   * Redeem positions after market is resolved
   */
  @Post('redeem')
  async redeemPositions(@Body() dto: RedeemPositionsDto) {
    try {
      this.logger.log('Received redeem positions request');
      const config = this.polymarketOnchainService.getDefaultConfig();
      if (!config) {
        throw new HttpException(
          'Polymarket config not found',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      const result = await this.polymarketOnchainService.redeemPositions(
        config,
        dto.marketCondition,
      );

      if (!result.success) {
        throw new HttpException(
          result.error || 'Redeem operation failed',
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        success: true,
        txHash: result.txHash,
        payoutInfo: result.payoutInfo,
        message: 'Positions redeemed successfully',
      };
    } catch (error: any) {
      this.logger.error(`Error in redeemPositions: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /polymarket-onchain/balances
   * Get wallet balances (USDC and position tokens)
   */
  @Post('balances')
  async getBalances(@Body() dto: GetBalancesDto) {
    try {
      this.logger.log('Received get balances request');
      const config = this.polymarketOnchainService.getDefaultConfig();
      if (!config) {
        throw new HttpException(
          'Polymarket config not found',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      const result = await this.polymarketOnchainService.getBalances(
        config,
        dto.conditionId,
      );

      return {
        success: true,
        balances: result,
      };
    } catch (error: any) {
      this.logger.error(`Error in getBalances: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /polymarket-onchain/cancel-orders
   * Cancel orders for a specific market or all markets
   */
  @Post('cancel-orders')
  async cancelOrders(@Body() dto: CancelOrdersDto) {
    try {
      this.logger.log('Received cancel orders request');
      const config = this.polymarketOnchainService.getDefaultConfig();
      if (!config) {
        throw new HttpException(
          'Polymarket config not found',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      const result = await this.polymarketOnchainService.cancelOrders(
        config,
        dto.tokenID,
      );

      if (!result.success) {
        throw new HttpException(
          result.error || 'Cancel operation failed',
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        success: true,
        message: dto.tokenID
          ? `Cancelled all orders for token ${dto.tokenID}`
          : 'Cancelled all orders',
      };
    } catch (error: any) {
      this.logger.error(`Error in cancelOrders: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /polymarket-onchain/health
   * Health check endpoint
   */
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'polymarket-onchain',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * GET /polymarket-onchain/redis-data
   * Get all Redis data related to mint operations (inventory and history)
   * Purpose: Export Redis data from server to sync with local environment
   */
  @Get('redis-data')
  @ApiOperation({
    summary: 'Export Redis data',
    description: 'Get all Redis keys and values matching the pattern. Used to export data from server to sync with local environment.',
  })
  @ApiQuery({
    name: 'pattern',
    required: false,
    type: String,
    description: 'Redis key pattern to filter keys (default: mint:*)',
    example: 'mint:*',
  })
  @ApiResponse({
    status: 200,
    description: 'Successfully exported Redis data',
    schema: {
      example: {
        success: true,
        totalKeys: 2,
        data: [
          {
            key: 'mint:inventory:btc-2026-01-22:0xb9b5cde0...',
            type: 'hash',
            value: { '12345': '100.5', '67890': '200.3' },
            ttl: 3600,
          },
          {
            key: 'mint:history:btc-2026-01-22:0xb9b5cde0...',
            type: 'list',
            value: ['{"type":"MINT","walletAddress":"0x123...","amount":100}'],
            ttl: 3600,
          },
        ],
        timestamp: '2026-01-22T10:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 500,
    description: 'Internal server error',
  })
  async getRedisData(
    @Query('pattern') pattern?: string,
  ) {
    try {
      this.logger.log('Received get Redis data request');
      const data = await this.polymarketOnchainService.exportRedisData(pattern);

      return {
        success: true,
        totalKeys: data.length,
        data,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error(`Error in getRedisData: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /polymarket-onchain/redis-data
   * Import Redis data to sync from server to local or vice versa
   * Purpose: Overwrite local Redis data with data from server
   */
  @Post('redis-data')
  @ApiOperation({
    summary: 'Import Redis data',
    description: 'Import and overwrite Redis data. Used to sync data from server to local or vice versa. WARNING: This will delete existing keys before importing.',
  })
  @ApiBody({
    type: ImportRedisDataDto,
    description: 'Redis data to import',
    examples: {
      example1: {
        summary: 'Import inventory and history data',
        value: {
          data: [
            {
              key: 'mint:inventory:btc-2026-01-22:0xb9b5cde0...',
              type: 'hash',
              value: { '12345': '100.5', '67890': '200.3' },
              ttl: 3600,
            },
            {
              key: 'mint:history:btc-2026-01-22:0xb9b5cde0...',
              type: 'list',
              value: ['{"type":"MINT","walletAddress":"0x123...","amount":100}'],
              ttl: 3600,
            },
          ],
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Successfully imported Redis data',
    schema: {
      example: {
        success: true,
        imported: 2,
        failed: 0,
        errors: [],
        timestamp: '2026-01-22T10:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request body',
  })
  @ApiResponse({
    status: 500,
    description: 'Internal server error',
  })
  async setRedisData(
    @Body() dto: ImportRedisDataDto,
  ) {
    try {
      this.logger.log(`Received set Redis data request with ${dto.data?.length || 0} keys`);

      if (!dto.data || !Array.isArray(dto.data)) {
        throw new HttpException(
          'Invalid request body. Expected { data: Array<{ key, type, value, ttl? }> }',
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.polymarketOnchainService.importRedisData(dto.data);

      return {
        success: true,
        imported: result.imported,
        failed: result.failed,
        errors: result.errors,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error(`Error in setRedisData: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /polymarket-onchain/mint/clear-cache
   * Clear all mint:* keys from Redis
   */
  @Post('clear-mint-cache')
  @ApiOperation({
    summary: 'Clear all mint cache keys from Redis',
    description: 'Deletes all Redis keys matching mint:* pattern',
  })
  async clearMintCache() {
    try {
      this.logger.log('Received request to clear mint cache');
      const result = await this.polymarketOnchainService.clearMintKeys();

      return result;
    } catch (error: any) {
      this.logger.error(`Error in clearMintCache: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /polymarket-onchain/order
   * Get order details by order hash
   */
  @Get('order')
  @ApiOperation({
    summary: 'Get order details by order hash',
    description: 'Retrieves order information from Polymarket CLOB using the order hash/ID',
  })
  @ApiQuery({
    name: 'orderHash',
    description: 'The order hash/ID to query (e.g., 0xb816482a5187a3d3db49cbaf6fe3ddf24f53e6c712b5a4bf5e01d0ec7b11dabc)',
    required: true,
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Order details retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        order: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Order ID' },
            status: { type: 'string', description: 'Order status (e.g., LIVE, MATCHED, CANCELLED)' },
            market: { type: 'string', description: 'Market condition ID' },
            original_size: { type: 'string', description: 'Original order size' },
            outcome: { type: 'string', description: 'Outcome (Yes/No)' },
            maker_address: { type: 'string', description: 'Maker wallet address' },
            price: { type: 'string', description: 'Order price' },
            side: { type: 'string', description: 'BUY or SELL' },
            size_matched: { type: 'string', description: 'Size that has been matched' },
            asset_id: { type: 'string', description: 'Token ID' },
            expiration: { type: 'string', description: 'Order expiration timestamp' },
            type: { type: 'string', description: 'Order type (GTC, FOK, etc.)' },
            created_at: { type: 'string', description: 'Order creation timestamp' },
          },
        },
      },
    },
  })
  async getOrder(@Query('orderHash') orderHash: string) {
    try {
      if (!orderHash) {
        throw new HttpException(
          'orderHash query parameter is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      this.logger.log(`Received request to get order: ${orderHash}`);
      const result = await this.polymarketOnchainService.getOrder(orderHash);

      if (!result.success) {
        throw new HttpException(
          result.error || 'Failed to get order',
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        success: true,
        order: result.order,
      };
    } catch (error: any) {
      this.logger.error(`Error in getOrder: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /polymarket-onchain/open-orders
   * Get all open/active orders for a specific market or all markets
   */
  @Get('open-orders')
  @ApiOperation({
    summary: 'Get open/active orders',
    description: 'Retrieves all open orders from Polymarket CLOB. Optionally filter by market conditionId.',
  })
  @ApiQuery({
    name: 'market',
    description: 'Optional market conditionId to filter orders (e.g., 0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af)',
    required: false,
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Open orders retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        count: { type: 'number', description: 'Number of open orders' },
        orders: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Order ID' },
              status: { type: 'string', description: 'Order status' },
              market: { type: 'string', description: 'Market condition ID' },
              original_size: { type: 'string', description: 'Original order size' },
              outcome: { type: 'string', description: 'Outcome (Yes/No)' },
              maker_address: { type: 'string', description: 'Maker wallet address' },
              price: { type: 'string', description: 'Order price' },
              side: { type: 'string', description: 'BUY or SELL' },
              size_matched: { type: 'string', description: 'Size matched so far' },
              asset_id: { type: 'string', description: 'Token ID' },
              type: { type: 'string', description: 'Order type (GTC, FOK, etc.)' },
              created_at: { type: 'string', description: 'Creation timestamp' },
            },
          },
        },
      },
    },
  })
  async getOpenOrders(@Query('market') market?: string) {
    try {
      this.logger.log(`Received request to get open orders${market ? ` for market: ${market}` : ''}`);
      const result = await this.polymarketOnchainService.getOpenOrders(market);

      if (!result.success) {
        throw new HttpException(
          result.error || 'Failed to get open orders',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        count: result.orders?.length || 0,
        orders: result.orders,
      };
    } catch (error: any) {
      this.logger.error(`Error in getOpenOrders: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /polymarket-onchain/trades
   * Get trade history for a specific market and/or maker address
   */
  @Get('trades')
  @ApiOperation({
    summary: 'Get trade history',
    description: 'Retrieves trade history from Polymarket CLOB. Can filter by id, market and/or maker address.',
  })
  @ApiQuery({
    name: 'id',
    description: 'Optional trade ID to fetch a specific trade',
    required: false,
    type: String,
  })
  @ApiQuery({
    name: 'market',
    description: 'Optional market conditionId to filter trades',
    required: false,
    type: String,
  })
  @ApiQuery({
    name: 'makerAddress',
    description: 'Optional maker address to filter trades (defaults to current wallet)',
    required: false,
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Trades retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        count: { type: 'number', description: 'Number of trades' },
        trades: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Trade ID' },
              taker_order_id: { type: 'string', description: 'Taker order ID' },
              market: { type: 'string', description: 'Market condition ID' },
              asset_id: { type: 'string', description: 'Token ID' },
              side: { type: 'string', description: 'BUY or SELL' },
              size: { type: 'string', description: 'Trade size' },
              fee_rate_bps: { type: 'string', description: 'Fee rate in basis points' },
              price: { type: 'string', description: 'Trade price' },
              status: { type: 'string', description: 'Trade status' },
              match_time: { type: 'string', description: 'Match timestamp' },
              outcome: { type: 'string', description: 'Outcome (Yes/No)' },
              maker_address: { type: 'string', description: 'Maker wallet address' },
              trader_side: { type: 'string', description: 'MAKER or TAKER' },
            },
          },
        },
      },
    },
  })
  async getTrades(
    @Query('id') id?: string,
    @Query('market') market?: string,
    @Query('makerAddress') makerAddress?: string,
  ) {
    try {
      this.logger.log(
        `Received request to get trades${id ? ` id: ${id}` : ''}${market ? ` for market: ${market}` : ''}${makerAddress ? `, maker: ${makerAddress}` : ''}`,
      );

      const result = await this.polymarketOnchainService.getTrades({
        id,
        market,
        makerAddress,
      });

      if (!result.success) {
        throw new HttpException(
          result.error || 'Failed to get trades',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        count: result.trades?.length || 0,
        trades: result.trades,
      };
    } catch (error: any) {
      this.logger.error(`Error in getTrades: ${error.message}`);
      throw new HttpException(
        error.message || 'Internal server error',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
