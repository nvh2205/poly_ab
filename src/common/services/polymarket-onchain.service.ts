import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Contract, Wallet, providers, utils, constants } from 'ethers';
import type {
  ApiKeyCreds,
  ClobClient as ClobClientType,
} from '@polymarket/clob-client';
import { loadPolymarketConfig } from './polymarket-onchain.config';
import { RedisService } from './redis.service';
import { APP_CONSTANTS } from '../constants/app.constants';
import axios, { AxiosInstance } from 'axios';
import * as https from 'https';
import * as crypto from 'crypto';

// Native Rust EIP-712 signing module for HFT performance (lazy loaded to bypass webpack)
let nativeCoreModule: any = null;
const loadNativeCore = (): any => {
  if (!nativeCoreModule) {
    try {
      // Use eval to bypass webpack static analysis of require
      // eslint-disable-next-line no-eval
      const dynamicRequire = eval('require');
      const path = dynamicRequire('path');
      nativeCoreModule = dynamicRequire(path.join(process.cwd(), 'native-core'));
    } catch (err) {
      console.warn('Native core module not available, will fallback to JS signing');
    }
  }
  return nativeCoreModule;
};

/**
 * Interface for Polymarket configuration
 */
export interface PolymarketConfig {
  polygonRpc: string;
  chainId: number;
  clobUrl: string;
  privateKey: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  proxyAddress: string;
}

/**
 * Interface for order parameters
 */
export interface OrderParams {
  tokenID: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  feeRateBps?: number;
}

/**
 * Interface for batch order parameters
 * According to Polymarket docs: https://docs.polymarket.com/developers/CLOB/orders/create-order-batch
 * Maximum 15 orders per batch
 */
export interface BatchOrderParams {
  tokenID: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  feeRateBps?: number;
  orderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK';
  postOnly?: boolean;
  /** Whether this is a negRisk market (uses different exchange contract) */
  negRisk?: boolean;
}

/**
 * Interface for batch order result
 */
export interface BatchOrderResult {
  success: boolean;
  orderID?: string;
  status?: string;
  errorMsg?: string;
}

/**
 * Interface for market condition
 */
export interface MarketCondition {
  conditionId: string;
  parentCollectionId?: string;
  partition?: number[];
  negRisk?: boolean;
  negRiskMarketID?: string; // Group ID for NegRisk adapter
}

/**
 * Polymarket On-chain Service
 * Handles trading, minting, merging and redeeming operations
 */
@Injectable()
export class PolymarketOnchainService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PolymarketOnchainService.name);

  // Cache for API credentials and authenticated clients (keyed by wallet address)
  private credentialsCache = new Map<string, ApiKeyCreds>();
  private clientCache = new Map<string, ClobClientType>();

  // Cache for negRisk status per token ID (keyed by tokenID string)
  private negRiskCache = new Map<string, boolean>();

  // Cache for wallet instances (keyed by private key hash for security)
  private walletCache = new Map<string, Wallet>();

  // Cache for CLOB types (loaded once at startup)
  private clobTypes: {
    OrderType: any;
    Side: any;
  } | null = null;

  // Native core module cache
  private nativeModule: any = null;

  // Default config loaded from environment variables
  private defaultConfig?: PolymarketConfig;

  // HFT-optimized axios client with persistent connections
  private hftHttpClient: AxiosInstance;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    const hftAgent = new https.Agent({
      keepAlive: true,
      noDelay: true,           // Tắt Nagle's algorithm (gửi gói tin ngay lập tức)
      keepAliveMsecs: 30000,   // Giữ socket sống 30s (SỬA LỖI CHẬM)
      maxSockets: Infinity,    // Không giới hạn socket
      scheduling: 'lifo',      // Ưu tiên dùng socket mới nhất
    });

    this.hftHttpClient = axios.create({
      baseURL: 'https://clob.polymarket.com',
      httpsAgent: hftAgent,
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'keep-alive', // Explicit header
      },
    });
  }

  // Contract addresses (Fixed for Polygon)
  private readonly RPC_READ_ONLY = 'https://silent-virulent-ensemble.matic.quiknode.pro/69d6739125c575fbfc5ba71b43023323742a9092/';
  private readonly CTF_EXCHANGE_ADDR =
    '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
  private readonly CTF_ADDR = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
  private readonly USDC_ADDR = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  private readonly NEGRISK_ADAPTER_ADDR =
    '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

  // ABIs
  private readonly ABIS = {
    ERC20: [
      'function approve(address spender, uint256 amount) returns (bool)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function balanceOf(address account) view returns (uint256)',
      'function decimals() view returns (uint8)',
    ],
    CTF: [
      'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
      'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
      'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
      'function balanceOf(address account, uint256 id) view returns (uint256)',
      'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
      'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
      'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)',
      'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
      'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)',

      // --- BỔ SUNG 2 DÒNG NÀY ---
      'function isApprovedForAll(address owner, address operator) view returns (bool)',
      'function setApprovalForAll(address operator, bool approved)',
    ],
    GNOSIS_SAFE: [
      'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
      'function nonce() view returns (uint256)',
    ],
    NEGRISK_ADAPTER: [
      // Sửa 'split' -> 'splitPosition'
      'function splitPosition(bytes32 conditionId, uint256 amount)',
      // Hàm chuyển đổi No -> Các Yes còn lại
      'function convertPositions(bytes32 marketId, uint256 indexSet, uint256 amount)',
      // Helper để tính toán Index (Optional, có thể tính off-chain)
      'function getPositionId(bytes32 questionId, bool outcome) view returns (uint256)',
      'function wcol() view returns (address)', // <--- THÊM HÀM NÀY
      'function mergePositions(bytes32 conditionId, uint256 amount)',
    ],
  };

  async onApplicationBootstrap(): Promise<void> {
    try {
      this.logger.log('Initializing Polymarket Onchain Service...');


      // Pre-load CLOB client module and cache types
      this.logger.log('Loading CLOB client module and caching types...');
      const { OrderType, Side } = await this.loadClob();
      this.clobTypes = { OrderType, Side };
      this.logger.log('CLOB client module and types cached successfully');

      // Load Native Core module
      this.logger.log('Loading Native Core module...');
      this.nativeModule = loadNativeCore();
      if (this.nativeModule) {
        this.logger.log('✅ Native Core module loaded successfully');
      } else {
        this.logger.warn('⚠️ Native Core module not available');
      }

      // Load default config from environment variables
      try {
        this.defaultConfig = loadPolymarketConfig();
        this.logger.log(
          `Default config loaded for wallet: ${this.defaultConfig ? new Wallet(this.defaultConfig.privateKey).address : 'N/A'}`,
        );

        // Pre-create wallet and API credentials for default wallet
        if (this.defaultConfig && this.defaultConfig.privateKey) {
          this.logger.log('Pre-caching wallet and API credentials for default wallet...');
          const wallet = this.buildWallet(this.defaultConfig);
          await this.getOrCreateCredentials(wallet, this.defaultConfig);
          // Also pre-warm the authenticated client
          await this.getOrCreateAuthenticatedClient(this.defaultConfig);
          this.logger.log(
            `✅ Wallet, credentials, and client cached for ${wallet.address}`,
          );
        }
      } catch (error: any) {
        this.logger.warn(
          `Could not load default config or create credentials: ${error.message}`,
        );
        this.logger.warn(
          'Service will work but credentials will be created on-demand',
        );
      }

      this.logger.log('Polymarket Onchain Service initialized successfully');
    } catch (error: any) {
      this.logger.error(
        `Failed to initialize Polymarket Onchain Service: ${error.message}`,
      );
      // Don't throw - allow service to start, errors will be handled per-operation
    }
  }

  // Default gas configuration (500 gwei as requested)
  private readonly DEFAULT_GAS_CONFIG = {
    maxFeePerGas: utils.parseUnits('500', 'gwei'),
    maxPriorityFeePerGas: utils.parseUnits('500', 'gwei'),
    gasLimit: 500000,
  };

  /**
   * Normalize partition array, defaulting to [1, 2] when invalid/missing
   * Note: Accepts 0-indexed partitions [0, 1] and converts to 1-indexed [1, 2]
   */
  private sanitizePartition(partition?: number[]): number[] {
    if (!Array.isArray(partition)) return [1, 2];

    const cleaned = Array.from(
      new Set(partition.filter((v) => Number.isInteger(v) && v >= 0)),
    );

    if (!cleaned.length) return [1, 2];

    // Convert 0-indexed to 1-indexed if needed
    const hasZero = cleaned.includes(0);
    if (hasZero) {
      return cleaned.map(v => v + 1);
    }

    return cleaned;
  }

  /**
   * Load CLOB client dynamically
   */
  private loadClob = (() => {
    let cached: Promise<typeof import('@polymarket/clob-client')> | null = null;
    const dynamicImport = new Function(
      'modulePath',
      'return import(modulePath);',
    ) as (
      modulePath: string,
    ) => Promise<typeof import('@polymarket/clob-client')>;
    return () => {
      if (!cached) cached = dynamicImport('@polymarket/clob-client');
      return cached;
    };
  })();

  /**
   * Get cached CLOB types (OrderType, Side)
   * If not cached, load and cache them
   */
  private async getClobTypes(): Promise<{ OrderType: any; Side: any }> {
    if (this.clobTypes) {
      return this.clobTypes;
    }

    const { OrderType, Side } = await this.loadClob();
    this.clobTypes = { OrderType, Side };
    return this.clobTypes;
  }

  /**
   * Build wallet from private key (cached for performance)
   * Wallet instances are cached by a hash of the private key to avoid repeated instantiation
   */
  private buildWallet(config: PolymarketConfig): Wallet {
    // Use a simple hash of private key as cache key (first 10 + last 10 chars)
    const keyHash = `${config.privateKey.slice(0, 12)}...${config.privateKey.slice(-10)}`;

    const cached = this.walletCache.get(keyHash);
    if (cached) {
      return cached;
    }

    let provider = new providers.JsonRpcProvider(config.polygonRpc);

    const wallet = new Wallet(config.privateKey, provider);
    this.walletCache.set(keyHash, wallet);
    return wallet;
  }



  /**
   * Get or create API credentials (cached by wallet address)
   */
  /**
   * Get API credentials and signer address for Rust batch order API.
   * Returns credentials from cache (created at startup or on-demand by the JS service).
   */
  async getApiCredentials(config?: PolymarketConfig): Promise<{
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
    signerAddress: string;
  }> {
    const cfg = config || this.defaultConfig;
    if (!cfg) {
      throw new Error('No Polymarket config available');
    }
    const wallet = this.buildWallet(cfg);
    const creds = await this.getOrCreateCredentials(wallet, cfg);
    return {
      apiKey: creds.key,
      apiSecret: creds.secret,
      apiPassphrase: creds.passphrase,
      signerAddress: wallet.address,
    };
  }

  private async getOrCreateCredentials(
    wallet: Wallet,
    config: PolymarketConfig,
  ): Promise<ApiKeyCreds> {
    const walletAddress = wallet.address;

    // Check if credentials provided in config
    if (config.apiKey && config.apiSecret && config.apiPassphrase) {
      const creds = {
        key: config.apiKey,
        secret: config.apiSecret,
        passphrase: config.apiPassphrase,
      };
      this.credentialsCache.set(walletAddress, creds);
      return creds;
    }

    // Check cache
    const cached = this.credentialsCache.get(walletAddress);
    if (cached) {
      this.logger.debug(`Using cached credentials for ${walletAddress}`);
      return cached;
    }

    // Create new credentials
    this.logger.log(`Creating new API credentials for ${walletAddress}...`);
    const tempClient = await this.createClient(wallet, config);
    const creds = await tempClient.createOrDeriveApiKey();

    // Cache for future use
    this.credentialsCache.set(walletAddress, creds);
    this.logger.log(`API credentials created and cached for ${walletAddress}`);

    return creds;
  }

  /**
   * Get the negRisk flag for a token from the CLOB API, with caching.
   * This is critical for EIP-712 signing — wrong negRisk = wrong domain separator = invalid signature.
   */
  async getNegRisk(tokenId: string): Promise<boolean> {
    const cached = this.negRiskCache.get(tokenId);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const response = await this.hftHttpClient.get(`/neg-risk`, {
        params: { token_id: tokenId },
        timeout: 3000,
      });
      const negRisk = response.data?.neg_risk === true;
      this.negRiskCache.set(tokenId, negRisk);
      this.logger.debug(`negRisk for token ${tokenId.slice(0, 20)}...: ${negRisk}`);
      return negRisk;
    } catch (error: any) {
      this.logger.warn(`Failed to fetch negRisk for token ${tokenId.slice(0, 20)}...: ${error.message}. Defaulting to false.`);
      return false;
    }
  }

  /**
   * Batch resolve negRisk for multiple token IDs (parallel, cached).
   */
  async resolveNegRiskBatch(tokenIds: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    const uncached: string[] = [];

    for (const tokenId of tokenIds) {
      const cached = this.negRiskCache.get(tokenId);
      if (cached !== undefined) {
        result.set(tokenId, cached);
      } else {
        uncached.push(tokenId);
      }
    }

    if (uncached.length > 0) {
      const promises = uncached.map(async (tokenId) => {
        const negRisk = await this.getNegRisk(tokenId);
        result.set(tokenId, negRisk);
      });
      await Promise.all(promises);
    }

    return result;
  }

  /**
   * Get or create authenticated CLOB client (cached by wallet address)
   */
  private async getOrCreateAuthenticatedClient(
    config: PolymarketConfig,
  ): Promise<ClobClientType> {
    const wallet = this.buildWallet(config);
    const walletAddress = wallet.address;

    // Check cache
    const cached = this.clientCache.get(walletAddress);
    if (cached) {
      this.logger.debug(`Using cached client for ${walletAddress}`);
      return cached;
    }

    // Get or create credentials
    const creds = await this.getOrCreateCredentials(wallet, config);

    // Create authenticated client
    this.logger.log(`Creating authenticated client for ${walletAddress}...`);
    const client = await this.createClient(wallet, config, creds);

    // Cache for future use
    this.clientCache.set(walletAddress, client);
    this.logger.log(
      `Authenticated client created and cached for ${walletAddress}`,
    );

    return client;
  }

  /**
   * Create CLOB client
   */
  private async createClient(
    wallet: Wallet,
    config: PolymarketConfig,
    creds?: ApiKeyCreds,
  ): Promise<ClobClientType> {
    const { ClobClient } = await this.loadClob();

    const resolvedCreds =
      creds ||
      (config.apiKey && config.apiSecret && config.apiPassphrase
        ? {
          key: config.apiKey,
          secret: config.apiSecret,
          passphrase: config.apiPassphrase,
        }
        : undefined);

    return new ClobClient(
      config.clobUrl,
      config.chainId,
      wallet,
      resolvedCreds,
      2, // SignatureType.POLY_GNOSIS_SAFE
      config.proxyAddress,
    );
  }

  /**
   * Get dynamic gas configuration based on current network conditions
   */
  private async getGasConfig(
    provider: providers.Provider,
    multiplier: number = 1,
  ) {
    try {
      const feeData = await provider.getFeeData();
      const MIN_GAS = utils.parseUnits('500', 'gwei'); // 500 gwei as requested

      let maxFee = feeData.maxFeePerGas || MIN_GAS;
      let maxPrio = feeData.maxPriorityFeePerGas || MIN_GAS;

      // Apply multiplier
      maxFee = maxFee.mul(Math.floor(multiplier * 100)).div(100);
      maxPrio = maxPrio.mul(Math.floor(multiplier * 100)).div(100);

      // Ensure minimum
      if (maxFee.lt(MIN_GAS)) maxFee = MIN_GAS;
      if (maxPrio.lt(MIN_GAS)) maxPrio = MIN_GAS;

      return {
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: maxPrio,
        gasLimit: 1000000,
      };
    } catch (error) {
      this.logger.warn('Failed to fetch gas data, using default config');
      return this.DEFAULT_GAS_CONFIG;
    }
  }

  /**
   * Calculate position IDs for YES and NO tokens
   */
  private async getPositionIds(
    ctfContract: Contract,
    conditionId: string,
  ): Promise<[string, string]> {
    const parentId = constants.HashZero;
    const indexSets = [1, 2]; // 1=Yes, 2=No

    const positionIds = [];
    for (const indexSet of indexSets) {
      const collectionId = await ctfContract.getCollectionId(
        parentId,
        conditionId,
        indexSet,
      );
      const positionId = await ctfContract.getPositionId(
        this.USDC_ADDR,
        collectionId,
      );
      positionIds.push(positionId);
    }

    return positionIds as [string, string];
  }

  /**
   * Place a limit order on Polymarket
   * Optimized: uses cached credentials and client
   */
  async placeLimitOrder(
    config: PolymarketConfig,
    orderParams: OrderParams,
  ): Promise<{ success: boolean; orderID?: string; error?: string }> {
    try {
      // Use cached authenticated client and types
      const [client, { OrderType, Side }] = await Promise.all([
        this.getOrCreateAuthenticatedClient(config),
        this.getClobTypes(),
      ]);

      const order = await client.createOrder({
        tokenID: orderParams.tokenID,
        price: orderParams.price,
        side: Side[orderParams.side],
        size: orderParams.size,
        feeRateBps: orderParams.feeRateBps || 0,
      });

      const response = await client.postOrder(order, OrderType.GTC);

      if (response && response.orderID) {
        return { success: true, orderID: response.orderID };
      } else {
        return { success: false, error: 'Order placement failed' };
      }
    } catch (error: any) {
      this.logger.error(`Error placing order: ${error.message}`);
      if (error.response?.data) {
        this.logger.error(
          `Server response: ${JSON.stringify(error.response.data)}`,
        );
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Place multiple orders in a single batch request
   * Maximum 15 orders per batch according to Polymarket documentation
   * Reference: https://docs.polymarket.com/developers/CLOB/orders/create-order-batch
   * Optimized: uses cached credentials and client
   */
  async placeBatchOrders(
    config: PolymarketConfig,
    orders: BatchOrderParams[],
  ): Promise<{
    success: boolean;
    results?: BatchOrderResult[];
    error?: string;
  }> {

    try {
      // Validate batch size
      if (orders.length === 0) {
        return { success: false, error: 'No orders provided' };
      }

      if (orders.length > 15) {
        return {
          success: false,
          error: 'Maximum 15 orders allowed per batch',
        };
      }

      // Get client and cached types (types are pre-loaded at startup)
      const [client, { OrderType, Side }] = await Promise.all([
        this.getOrCreateAuthenticatedClient(config),
        this.getClobTypes(),
      ]);

      // Pre-create orderTypeMap (moved outside loop for better performance)
      const orderTypeMap: Record<string, any> = {
        GTC: OrderType.GTC,
        GTD: OrderType.GTD,
        FOK: OrderType.FOK,
        FAK: OrderType.FAK,
      };

      // Create all orders in parallel (faster than sequential)
      const createStartTime = performance.now();
      const batchOrdersArgs = await Promise.all(
        orders.map(async (orderParams) => {
          const order = await client.createOrder({
            tokenID: orderParams.tokenID,
            price: orderParams.price,
            side: Side[orderParams.side],
            size: orderParams.size,
            feeRateBps: orderParams.feeRateBps || 0,
          });

          const orderType = orderParams.orderType
            ? orderTypeMap[orderParams.orderType]
            : OrderType.GTC;

          return {
            order,
            orderType,
            ...(orderParams.postOnly !== undefined && {
              postOnly: orderParams.postOnly,
            }),
          };
        }),
      );
      const createEndTime = performance.now();
      this.logger.log(`⏱️ createOrder took ${(createEndTime - createStartTime).toFixed(2)}ms for ${orders.length} orders`);

      // return;
      // Post batch orders - this is the actual network request
      const responses = await client.postOrders(batchOrdersArgs);
      const timePostOrders = performance.now();
      this.logger.log(`⏱️ postOrders took ${(timePostOrders - createEndTime).toFixed(2)}ms for ${orders.length} orders`);

      // const responses = await client.postOrders([
      //   {
      //     order: {
      //       salt: '1513659195724',
      //       maker: '0x33568DB0DfB9890f5107Fb50F566a159F6f612ED',
      //       signer: '0x4769B103570877eCD516BC7737DcFD834413E6b4',
      //       taker: '0x0000000000000000000000000000000000000000',
      //       tokenId: '17510381696424521626872545793830070082360183532089020912133870456423861609957',
      //       makerAmount: '1500000',
      //       takerAmount: '3000000',
      //       expiration: '0',
      //       nonce: '0',
      //       feeRateBps: '0',
      //       side: 0,
      //       signatureType: 2,
      //       signature: '0x1df919ac4b8293f958f0bf9f8ae63add401f33f6cb1bbbce6c02c5e70dae554870166014736ab545319416a896607ddb86eddeb0c1cda3be9b8173f5281b9f841c'
      //     },
      //     orderType: OrderType.GTC  
      //   },
      //   {
      //     order: {
      //       salt: '1415934701716',
      //       maker: '0x33568DB0DfB9890f5107Fb50F566a159F6f612ED',
      //       signer: '0x4769B103570877eCD516BC7737DcFD834413E6b4',
      //       taker: '0x0000000000000000000000000000000000000000',
      //       tokenId: '109066040035841146303043175611007476656066351597299570056854175718288126977489',
      //       makerAmount: '1500000',
      //       takerAmount: '4000000',
      //       expiration: '0',
      //       nonce: '0',
      //       feeRateBps: '0',
      //       side: 0,
      //       signatureType: 2,
      //       signature: '0x8b5f5196f1012c40793706002e572fedc81e48c14b5709d4a2d941126dff1cf854efe09a49acc6e8e98a4f3e82ea1209e585603b61288cb5fa416da38d0175061c'
      //     },
      //     orderType: OrderType.GTC
      //   }
      // ]);

      // Process responses - optimized with pre-allocated array and direct access
      const results: BatchOrderResult[] = new Array(
        Array.isArray(responses) ? responses.length : 0,
      );
      let successCount = 0;
      let failureCount = 0;

      if (Array.isArray(responses)) {
        for (let i = 0; i < responses.length; i++) {
          const response = responses[i];

          if (response && response.orderID) {
            successCount++;
            results[i] = {
              success: true,
              orderID: response.orderID,
              status: response.status || 'unknown',
              errorMsg: response.errorMsg || '',
            };
          } else {
            failureCount++;
            results[i] = {
              success: false,
              errorMsg: response?.errorMsg || `Order ${i + 1} placement failed`,
            };
          }
        }
      }

      const timeEndFunction = performance.now();
      this.logger.log(`⏱️ postOrders took ${(timeEndFunction - createStartTime).toFixed(2)}ms for ${orders.length} orders`);



      return {
        success: true,
        results,
      };
    } catch (error: any) {

      return { success: false, error: error.message };
    }
  }

  /**
   * Place multiple orders using native Rust EIP-712 signing (HFT optimized)
   * Uses native-core module for ~10x faster signing compared to JS
   * Maximum 15 orders per batch according to Polymarket documentation
   */
  async placeBatchOrdersNative(
    config: PolymarketConfig,
    orders: BatchOrderParams[],
  ): Promise<{
    success: boolean;
    results?: BatchOrderResult[];
    error?: string;
  }> {

    try {
      // Validate batch size
      if (orders.length === 0) {
        return { success: false, error: 'No orders provided' };
      }

      if (orders.length > 15) {
        return {
          success: false,
          error: 'Maximum 15 orders allowed per batch',
        };
      }

      // Get wallet addresses from config (synchronous - do first)
      const wallet = this.buildWallet(config);
      const signerAddress = wallet.address;
      const makerAddress = config.proxyAddress;

      // Get client and cached types (parallel async operations)
      const [client, { OrderType }] = await Promise.all([
        this.getOrCreateAuthenticatedClient(config),
        this.getClobTypes(),
      ]);

      // Pre-create orderTypeMap
      const orderTypeMap: Record<string, any> = {
        GTC: OrderType.GTC,
        GTD: OrderType.GTD,
        FOK: OrderType.FOK,
        FAK: OrderType.FAK,
      };

      // USDC has 6 decimals, shares also have 6 decimals
      const DECIMALS = 1_000_000;


      const batchOrderParams = orders.map((orderParams) => {
        const priceDecimal = orderParams.price;
        const sizeDecimal = orderParams.size;
        const side = orderParams.side === 'BUY' ? 0 : 1;

        // Calculate amounts based on side
        // Constraint: Maker Amount (USDC) max 4 decimals, Taker Amount (Shares) max 2 decimals for BUY
        // This implies: Asset (Shares) always max 2 decimals, USDC (Collateral) always max 4 decimals

        // 1. Round size (Asset) to 2 decimals
        const sizeRounded = Number(sizeDecimal.toFixed(2));

        // 2. Calculate USDC amount based on rounded size and price, then round to 4 decimals
        const usdcRaw = priceDecimal * sizeRounded;
        const usdcRounded = Number(usdcRaw.toFixed(4));

        let makerAmount: string;
        let takerAmount: string;

        if (side === 0) {
          // BUY: Maker = USDC, Taker = Asset
          makerAmount = Math.round(usdcRounded * DECIMALS).toString();
          takerAmount = Math.round(sizeRounded * DECIMALS).toString();
        } else {
          // SELL: Maker = Asset, Taker = USDC
          makerAmount = Math.round(sizeRounded * DECIMALS).toString();
          takerAmount = Math.round(usdcRounded * DECIMALS).toString();
        }

        return {
          // No privateKey here anymore
          salt: Math.round(Math.random() * Date.now()).toString(),
          maker: makerAddress,
          signer: signerAddress,
          taker: '0x0000000000000000000000000000000000000000',
          tokenId: orderParams.tokenID,
          makerAmount,
          takerAmount,
          expiration: '0',
          nonce: '0',
          feeRateBps: (orderParams.feeRateBps || 0).toString(),
          side,
          signatureType: 2, // POLY_GNOSIS_SAFE
          negRisk: orderParams.negRisk, // Default to true if not specified? 
        };
      });


      // Batch sign using native Rust module
      if (!this.nativeModule) {
        return { success: false, error: 'Native core module not available. Please build native-core first.' };
      }

      // Pass private key separately
      const signedOrders = this.nativeModule.signClobOrdersBatch(config.privateKey, batchOrderParams);


      // Transform to CLOB order format
      const batchOrdersArgs = signedOrders.map((signed: any, idx: number) => {
        const orderType = orders[idx].orderType
          ? orderTypeMap[orders[idx].orderType!]
          : OrderType.GTC;

        return {
          order: {
            salt: signed.salt,
            maker: signed.maker,
            signer: signed.signer,
            taker: signed.taker,
            tokenId: signed.tokenId,
            makerAmount: signed.makerAmount,  // makerAmount: signed.makerAmount,
            takerAmount: signed.takerAmount,
            expiration: signed.expiration,
            nonce: signed.nonce,
            feeRateBps: signed.feeRateBps,
            side: signed.side,
            signatureType: signed.signatureType,
            signature: signed.signature,
          },
          orderType,
          ...(orders[idx].postOnly !== undefined && {
            postOnly: orders[idx].postOnly,
          }),
        };
      });

      // Post batch orders
      const responses = await client.postOrders(batchOrdersArgs);

      // Process responses
      const results: BatchOrderResult[] = new Array(
        Array.isArray(responses) ? responses.length : 0,
      );

      if (Array.isArray(responses)) {
        for (let i = 0; i < responses.length; i++) {
          const response = responses[i];

          if (response && response.orderID) {
            results[i] = {
              success: true,
              orderID: response.orderID,
              status: response.status || 'unknown',
              errorMsg: response.errorMsg || '',
            };
          } else {
            results[i] = {
              success: false,
              errorMsg: response?.errorMsg || `Order ${i + 1} placement failed`,
            };
          }
        }
      }

      return {
        success: true,
        results,
      };
    } catch (error: any) {
      this.logger.error(`[NATIVE] placeBatchOrdersNative error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Build HMAC-SHA256 signature for Polymarket L2 API authentication
   * Matches the buildPolyHmacSignature from @polymarket/clob-client
   * @param secret API secret key (base64 encoded)
   * @param timestamp Current timestamp in seconds (number)
   * @param method HTTP method (GET, POST, etc.)
   * @param requestPath API endpoint path
   * @param body Request body (optional)
   * @returns URL-safe base64-encoded HMAC signature
   */
  private buildHmacSignature(
    secret: string,
    timestamp: number,
    method: string,
    requestPath: string,
    body?: string,
  ): string {
    // Build message exactly like Polymarket: timestamp + method + requestPath + body
    let message = timestamp + method + requestPath;
    if (body !== undefined) {
      message += body;
    }

    // Decode base64 secret (handle both base64 and base64url formats)
    const sanitizedSecret = secret
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/[^A-Za-z0-9+/=]/g, '');
    const key = Buffer.from(sanitizedSecret, 'base64');

    // Create HMAC-SHA256 signature
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(message);
    const sig = hmac.digest('base64');

    // Convert to URL-safe base64: '+' -> '-', '/' -> '_'
    const sigUrlSafe = sig.replace(/\+/g, '-').replace(/\//g, '_');
    return sigUrlSafe;
  }

  /**
   * Build L2 authentication headers for Polymarket CLOB API
   * @param creds API credentials (key, secret, passphrase)
   * @param method HTTP method
   * @param requestPath API endpoint path
   * @param body Request body (optional)
   * @returns Headers object with L2 auth headers
   */
  private buildL2AuthHeaders(
    creds: ApiKeyCreds,
    method: string,
    requestPath: string,
    body?: string,
  ): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.buildHmacSignature(
      creds.secret,
      timestamp,
      method,
      requestPath,
      body,
    );

    return {
      'POLY_ADDRESS': '',  // Will be set by caller
      'POLY_SIGNATURE': signature,
      'POLY_TIMESTAMP': timestamp.toString(),
      'POLY_API_KEY': creds.key,
      'POLY_PASSPHRASE': creds.passphrase,
    };
  }

  /**
   * Place multiple orders using native Rust signing + HFT-optimized axios client
   * Uses native-core module for ~10x faster signing compared to JS
   * Uses persistent HTTP connections with Nagle's Algorithm disabled for minimal latency
   * Maximum 15 orders per batch according to Polymarket documentation
   * 
   * @param config Polymarket configuration
   * @param orders Array of batch order parameters
   * @returns Batch order result with success status and order IDs
   */
  async placeBatchOrdersAxios(
    config: PolymarketConfig,
    orders: BatchOrderParams[],
  ): Promise<{
    success: boolean;
    results?: BatchOrderResult[];
    error?: string;
  }> {
    const startTime = performance.now();

    try {
      // Validate batch size
      if (orders.length === 0) {
        return { success: false, error: 'No orders provided' };
      }

      if (orders.length > 15) {
        return {
          success: false,
          error: 'Maximum 15 orders allowed per batch',
        };
      }

      // Phase 1: Get wallet addresses from config (synchronous - do first)
      const phase1Start = performance.now();
      const wallet = this.buildWallet(config);
      const signerAddress = wallet.address;
      const makerAddress = config.proxyAddress;

      // Get cached types and credentials (parallel async operations)
      const [{ OrderType }, creds] = await Promise.all([
        this.getClobTypes(),
        this.getOrCreateCredentials(wallet, config),
      ]);
      const phase1End = performance.now();
      this.logger.log(`⏱️ [AXIOS] Phase 1 (init + creds): ${(phase1End - phase1Start).toFixed(2)}ms`);

      // Pre-create orderTypeMap
      const orderTypeMap: Record<string, any> = {
        GTC: 'GTC',
        GTD: 'GTD',
        FOK: 'FOK',
        FAK: 'FAK',
      };

      // USDC has 6 decimals, shares also have 6 decimals
      const DECIMALS = 1_000_000;

      // Phase 2: Prepare order parameters
      const phase2Start = performance.now();
      const batchOrderParams = orders.map((orderParams) => {
        const priceDecimal = orderParams.price;
        const sizeDecimal = orderParams.size;
        const side = orderParams.side === 'BUY' ? 0 : 1;

        // Calculate amounts based on side
        // Constraint: Maker Amount (USDC) max 4 decimals, Taker Amount (Shares) max 2 decimals for BUY
        // 1. Round size (Asset) to 2 decimals
        const sizeRounded = Number(sizeDecimal.toFixed(2));

        // 2. Calculate USDC amount based on rounded size and price, then round to 4 decimals
        const usdcRaw = priceDecimal * sizeRounded;
        const usdcRounded = Number(usdcRaw.toFixed(4));

        let makerAmount: string;
        let takerAmount: string;

        if (side === 0) {
          // BUY: Maker = USDC, Taker = Asset
          makerAmount = Math.round(usdcRounded * DECIMALS).toString();
          takerAmount = Math.round(sizeRounded * DECIMALS).toString();
        } else {
          // SELL: Maker = Asset, Taker = USDC
          makerAmount = Math.round(sizeRounded * DECIMALS).toString();
          takerAmount = Math.round(usdcRounded * DECIMALS).toString();
        }

        return {
          salt: Math.round(Math.random() * Date.now()).toString(),
          maker: makerAddress,
          signer: signerAddress,
          taker: '0x0000000000000000000000000000000000000000',
          tokenId: orderParams.tokenID,
          makerAmount,
          takerAmount,
          expiration: '0',
          nonce: '0',
          feeRateBps: (orderParams.feeRateBps || 0).toString(),
          side,
          signatureType: 2, // POLY_GNOSIS_SAFE
          negRisk: orderParams.negRisk,
        };
      });
      const phase2End = performance.now();
      this.logger.log(`⏱️ [AXIOS] Phase 2 (prepare params): ${(phase2End - phase2Start).toFixed(2)}ms`);

      // Phase 3: Batch sign using native Rust module
      const phase3Start = performance.now();
      if (!this.nativeModule) {
        return { success: false, error: 'Native core module not available. Please build native-core first.' };
      }

      // Pass private key separately for native signing
      const signedOrders = this.nativeModule.signClobOrdersBatch(config.privateKey, batchOrderParams);
      const phase3End = performance.now();
      this.logger.log(`⏱️ [AXIOS] Phase 3 (native signing): ${(phase3End - phase3Start).toFixed(2)}ms for ${orders.length} orders`);

      // Phase 4: Transform to CLOB order format for API request (matching orderToJson format)
      const phase4Start = performance.now();
      const batchOrdersPayload = signedOrders.map((signed: any, idx: number) => {
        const orderType = orders[idx].orderType
          ? orderTypeMap[orders[idx].orderType!]
          : 'GTC';

        // Match the orderToJson format from @polymarket/clob-client
        return {
          deferExec: false,
          order: {
            salt: parseInt(signed.salt, 10), // Must be integer
            maker: signed.maker,
            signer: signed.signer,
            taker: signed.taker,
            tokenId: signed.tokenId,
            makerAmount: signed.makerAmount,
            takerAmount: signed.takerAmount,
            side: signed.side === 0 ? 'BUY' : 'SELL', // String enum, not number
            expiration: signed.expiration,
            nonce: signed.nonce,
            feeRateBps: signed.feeRateBps,
            signatureType: signed.signatureType,
            signature: signed.signature,
          },
          owner: creds.key, // API key as owner
          orderType,
        };
      });
      const phase4End = performance.now();
      this.logger.log(`⏱️ [AXIOS] Phase 4 (transform payload): ${(phase4End - phase4Start).toFixed(2)}ms`);

      // Phase 5: Build L2 auth headers for the request
      const phase5Start = performance.now();
      const requestPath = '/orders'; // Batch endpoint uses /orders (plural)
      const bodyStr = JSON.stringify(batchOrdersPayload);
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = this.buildHmacSignature(creds.secret, timestamp, 'POST', requestPath, bodyStr);

      const authHeaders = {
        'POLY_ADDRESS': signerAddress, // Must be signer address (wallet), not proxy
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': timestamp.toString(),
        'POLY_API_KEY': creds.key,
        'POLY_PASSPHRASE': creds.passphrase,
      };
      const phase5End = performance.now();
      this.logger.log(`⏱️ [AXIOS] Phase 5 (HMAC auth): ${(phase5End - phase5Start).toFixed(2)}ms`);

      // Phase 6: Post batch orders using HFT-optimized axios client
      const phase6Start = performance.now();
      const response = await this.hftHttpClient.post(requestPath, batchOrdersPayload, {
        headers: authHeaders,
      });
      const phase6End = performance.now();
      this.logger.log(`⏱️ [AXIOS] Phase 6 (HTTP POST): ${(phase6End - phase6Start).toFixed(2)}ms`);

      const responses = response.data;

      // Process responses
      const results: BatchOrderResult[] = new Array(
        Array.isArray(responses) ? responses.length : 0,
      );

      if (Array.isArray(responses)) {
        for (let i = 0; i < responses.length; i++) {
          const resp = responses[i];

          if (resp && resp.orderID) {
            results[i] = {
              success: true,
              orderID: resp.orderID,
              status: resp.status || 'unknown',
              errorMsg: resp.errorMsg || '',
            };
          } else {
            results[i] = {
              success: false,
              errorMsg: resp?.errorMsg || `Order ${i + 1} placement failed`,
            };
          }
        }
      }

      const totalTime = performance.now() - startTime;
      this.logger.log(`⏱️ [AXIOS] Total placeBatchOrdersAxios: ${totalTime.toFixed(2)}ms for ${orders.length} orders`);

      return {
        success: true,
        results,
      };
    } catch (error: any) {
      const totalTime = performance.now() - startTime;
      this.logger.error(`[AXIOS] placeBatchOrdersAxios error after ${totalTime.toFixed(2)}ms: ${error.message}`);
      if (error.response?.data) {
        this.logger.error(`[AXIOS] Server response: ${JSON.stringify(error.response.data)}`);
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Create order only (without posting to exchange)
   * Saves the order to a JSON file organized by tokenID
   * @param config Polymarket configuration
   * @param orders Array of order parameters
   * @returns Array of created orders with metadata
   */
  async createOrderOnly(
    config: PolymarketConfig,
    orders: BatchOrderParams[],
  ): Promise<{
    success: boolean;
    orders?: Array<{
      order: any;
      postOnly?: boolean;
      tokenID: string;
      savedToFile: string;
    }>;
    error?: string;
  }> {
    try {
      if (orders.length === 0) {
        return { success: false, error: 'No orders provided' };
      }

      // Get client and cached types
      const [client, { OrderType, Side }] = await Promise.all([
        this.getOrCreateAuthenticatedClient(config),
        this.getClobTypes(),
      ]);



      // Create all orders in parallel
      const createdOrders = await Promise.all(
        orders.map(async (orderParams) => {
          const order = await client.createOrder({
            tokenID: orderParams.tokenID,
            price: orderParams.price,
            side: Side[orderParams.side],
            size: orderParams.size,
            feeRateBps: orderParams.feeRateBps || 0,
          });

          const result = {
            order,
            ...(orderParams.postOnly !== undefined && {
              postOnly: orderParams.postOnly,
            }),
          };

          // Save to JSON file by tokenID
          const savedToFile = await this.saveOrderToJsonFile(
            orderParams.tokenID,
            result,
            orderParams,
          );

          return {
            ...result,
            tokenID: orderParams.tokenID,
            savedToFile,
          };
        }),
      );

      return {
        success: true,
        orders: createdOrders,
      };
    } catch (error: any) {
      this.logger.error(`Error in createOrderOnly: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Save order to JSON file organized by tokenID
   * File path: data/orders/{tokenID}.json
   */
  private async saveOrderToJsonFile(
    tokenID: string,
    orderResult: any,
    orderParams: BatchOrderParams,
  ): Promise<string> {
    const fs = await import('fs').then((m) => m.promises);
    const path = await import('path');

    // Create directory if not exists
    const orderDir = path.join(process.cwd(), 'data', 'orders');
    try {
      await fs.mkdir(orderDir, { recursive: true });
    } catch (e) {
      // Directory might already exist
    }

    // Sanitize tokenID for filename (replace problematic characters)
    const sanitizedTokenID = tokenID.replace(/[^a-zA-Z0-9-_]/g, '_');
    const filePath = path.join(orderDir, `${sanitizedTokenID}.json`);

    // Read existing data or create new array
    let existingData: any[] = [];
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      existingData = JSON.parse(fileContent);
    } catch (e) {
      // File doesn't exist, start with empty array
    }

    // Add new order with timestamp
    const orderEntry = {
      timestamp: new Date().toISOString(),
      orderParams: {
        tokenID: orderParams.tokenID,
        price: orderParams.price,
        side: orderParams.side,
        size: orderParams.size,
        feeRateBps: orderParams.feeRateBps,
        orderType: orderParams.orderType,
        postOnly: orderParams.postOnly,
      },
      orderResult: orderResult,
    };

    existingData.push(orderEntry);

    // Write back to file
    await fs.writeFile(filePath, JSON.stringify(existingData, null, 2), 'utf-8');

    this.logger.log(`Order saved to ${filePath}`);
    return filePath;
  }

  /**
   * Save mint position to Redis grouped by groupKey (arbitrage signal key)
   * Key Format: mint:inventory:{groupKey}:{walletAddress}
   */
  private async saveMintPositionToRedis(
    walletAddress: string,
    groupKey: string,
    positionIds: string[],
    amountUSDC: string,
    txHash: string,
    transferTxHash?: string,
  ): Promise<void> {
    try {
      const mintedAmount = Number(amountUSDC) || 0;
      const ttlSeconds = APP_CONSTANTS.MINTED_ASSETS_CACHE_TTL;
      const timestamp = new Date().toISOString();
      const normalizedWalletAddress = walletAddress.toLowerCase();

      const pipeline = this.redisService.getClient().pipeline();
      const inventoryKey = `mint:inventory:${groupKey}:${normalizedWalletAddress}`;

      positionIds.forEach((tokenId) => {
        pipeline.hincrbyfloat(inventoryKey, tokenId, mintedAmount);
      });
      pipeline.expire(inventoryKey, ttlSeconds);

      // Audit history per groupKey
      const positionHistoryKey = `mint:history:${groupKey}:${normalizedWalletAddress}`;
      const positionEvent = {
        type: 'MINT',
        walletAddress: normalizedWalletAddress,
        groupKey,
        positionIds,
        amountUSDC,
        txHash,
        transferTxHash,
        timestamp,
      };
      pipeline.rpush(positionHistoryKey, JSON.stringify(positionEvent));
      pipeline.expire(positionHistoryKey, ttlSeconds);

      await pipeline.exec();

      this.logger.log(
        `Mint inventory cached for ${groupKey}. Added ${mintedAmount} to balances.`,
      );
    } catch (error: any) {
      this.logger.error(`Failed to save mint position: ${error.message}`);
    }
  }

  /**
   *   tokens (split position) by depositing USDC
   */
  async mintTokens(
    config: PolymarketConfig,
    marketCondition: MarketCondition,
    amountUSDC: number,
    groupKey: string,
  ): Promise<{
    success: boolean;
    txHash?: string;
    transferTxHash?: string;
    error?: string;
  }> {
    try {
      const wallet = this.buildWallet(config);
      this.logger.log(`Starting mint operation for wallet: ${wallet.address}`);
      this.logger.log(`Amount: ${amountUSDC} USDC`);

      const usdcContract = new Contract(
        this.USDC_ADDR,
        this.ABIS.ERC20,
        wallet,
      );
      const ctfContract = new Contract(this.CTF_ADDR, this.ABIS.CTF, wallet);
      const amountWei = utils.parseUnits(amountUSDC.toString(), 6);

      // Get gas configuration
      const gasConfig = await this.getGasConfig(wallet.provider);

      // Step 1: Check balance
      const balance = await usdcContract.balanceOf(wallet.address);
      if (balance.lt(amountWei)) {
        const errorMsg = `Insufficient balance! You have: ${utils.formatUnits(balance, 6)} USDC`;
        this.logger.error(errorMsg);
        return { success: false, error: errorMsg };
      }

      // Step 2: Approve if needed
      const allowance = await usdcContract.allowance(
        wallet.address,
        this.CTF_ADDR,
      );
      if (allowance.lt(amountWei)) {
        this.logger.log('Approving USDC...');
        const txApprove = await usdcContract.approve(
          this.CTF_ADDR,
          constants.MaxUint256,
          gasConfig,
        );
        this.logger.log(`Approve tx sent: ${txApprove.hash}`);
        await txApprove.wait();
        this.logger.log('Approval confirmed');
      }

      // Step 3: Split position (mint)
      this.logger.log('Executing splitPosition...');
      const resolvedPartition = this.sanitizePartition(
        marketCondition.partition,
      );

      const txSplit = await ctfContract.splitPosition(
        this.USDC_ADDR,
        marketCondition.parentCollectionId || constants.HashZero,
        marketCondition.conditionId,
        resolvedPartition,
        amountWei,
        gasConfig,
      );

      this.logger.log(`Split tx sent: ${txSplit.hash}`);
      await txSplit.wait();

      this.logger.log(`Mint successful! Tokens minted to ${wallet.address}`);

      // Get position IDs for Redis tracking
      const parentCollectionId =
        marketCondition.parentCollectionId || constants.HashZero;
      const positionIds = await Promise.all(
        resolvedPartition.map(async (indexSet) => {
          const collectionId = await ctfContract.getCollectionId(
            parentCollectionId,
            marketCondition.conditionId,
            indexSet,
          );
          return ctfContract.getPositionId(this.USDC_ADDR, collectionId);
        }),
      );

      // Transfer freshly minted tokens to proxy wallet if configured
      const proxyAddress = config.proxyAddress;
      let transferTxHash: string | undefined;

      if (proxyAddress) {
        if (proxyAddress.toLowerCase() === wallet.address.toLowerCase()) {
          this.logger.log(
            'Proxy address matches signer wallet, skipping transfer',
          );
        } else {
          const transferAmounts = positionIds.map(() => amountWei);

          this.logger.log(
            `Transferring minted tokens to proxy ${proxyAddress} (ids: ${positionIds.join(',')})`,
          );

          const transferTx = await ctfContract.safeBatchTransferFrom(
            wallet.address,
            proxyAddress,
            positionIds,
            transferAmounts,
            '0x',
            gasConfig,
          );

          this.logger.log(`Transfer tx sent: ${transferTx.hash}`);
          await transferTx.wait();
          transferTxHash = transferTx.hash;
          this.logger.log(`Tokens transferred to proxy wallet ${proxyAddress}`);
        }
      } else {
        this.logger.warn(
          'proxyAddress not provided; minted tokens remain in signer wallet',
        );
      }

      // Save mint position to Redis for position management
      await this.saveMintPositionToRedis(
        wallet.address,
        groupKey,
        positionIds.map((id) => id.toString()),
        amountUSDC.toString(),
        txSplit.hash,
        transferTxHash,
      );

      return { success: true, txHash: txSplit.hash, transferTxHash };
    } catch (error: any) {
      this.logger.error(`Error minting tokens: ${error.message || error}`);
      return { success: false, error: error.message || 'Mint failed' };
    }
  }

  /**
   * Merge positions (YES + NO tokens back to USDC)
   */
  async mergePositions(
    config: PolymarketConfig,
    marketCondition: MarketCondition,
    amount?: number,
  ): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
    amountMerged?: string;
  }> {
    try {
      const wallet = this.buildWallet(config);
      this.logger.log(`Starting merge operation for wallet: ${wallet.address}`);

      // --- LOGIC MỚI CHO NEGRISK ---
      if (marketCondition.negRisk && marketCondition.negRiskMarketID) {
        this.logger.log(`🚀 NegRisk Merge Strategy Detected`);
        const adapterAddress = this.NEGRISK_ADAPTER_ADDR;
        const adapterInterface = new utils.Interface(this.ABIS.NEGRISK_ADAPTER);
        const ctfContract = new Contract(this.CTF_ADDR, this.ABIS.CTF, wallet);
        const proxyAddress = config.proxyAddress;
        const amountWei = utils.parseUnits(amount?.toString() || '0', 6);
        // 1. Kiểm tra Approve trên CTF
        // Adapter cần quyền để "rút" token YES/NO từ ví Proxy về để merge
        const isApproved = await ctfContract.isApprovedForAll(
          proxyAddress,
          adapterAddress,
        );
        if (!isApproved) {
          this.logger.log(`Approving Adapter on CTF...`);
          const ctfInterface = new utils.Interface(this.ABIS.CTF);
          const approveData = ctfInterface.encodeFunctionData(
            'setApprovalForAll',
            [adapterAddress, true],
          );
          const txApprove = await this.execProxyTx(
            wallet,
            proxyAddress,
            this.CTF_ADDR,
            approveData,
          );
          await txApprove.wait();
          this.logger.log(`Adapter approved on CTF.`);
        }

        // 2. Xác định số lượng cần Merge
        // Nếu user không truyền amount, ta cần check balance của token YES/NO (WCOL based)
        let mergeAmountWei = amountWei;

        if (!mergeAmountWei) {
          // Logic lấy balance hơi phức tạp vì cần tính TokenID theo WCOL
          // Để đơn giản, nếu không truyền amount, ta báo lỗi hoặc yêu cầu truyền vào
          // Hoặc bạn có thể tái sử dụng logic tính TokenID WCOL ở câu trả lời trước để fetch balance
          return {
            success: false,
            error: "For NegRisk merge, please specify explicit 'amount'",
          };
        }

        // 3. Gọi Adapter Merge
        // Adapter sẽ: Pull tokens -> Merge trên CTF -> Nhận WCOL -> Unwrap WCOL -> Trả USDC cho Proxy
        const mergeData = adapterInterface.encodeFunctionData(
          'mergePositions',
          [marketCondition.conditionId, mergeAmountWei],
        );

        const txMerge = await this.execProxyTx(
          wallet,
          proxyAddress,
          adapterAddress,
          mergeData,
        );

        this.logger.log(`Merge TX Sent: ${txMerge.hash}`);
        await txMerge.wait();

        return {
          success: true,
          txHash: txMerge.hash,
          amountMerged: amount?.toString(),
        };
      }

      const ctfContract = new Contract(this.CTF_ADDR, this.ABIS.CTF, wallet);
      const usdcContract = new Contract(
        this.USDC_ADDR,
        this.ABIS.ERC20,
        wallet,
      );

      // Step 1: Get token IDs
      const [yesTokenId, noTokenId] = await this.getPositionIds(
        ctfContract,
        marketCondition.conditionId,
      );

      // Step 2: Check balances
      const balances = await ctfContract.balanceOfBatch(
        [wallet.address, wallet.address],
        [yesTokenId, noTokenId],
      );

      const balanceYes = balances[0];
      const balanceNo = balances[1];

      this.logger.log(`Balance YES: ${utils.formatUnits(balanceYes, 6)}`);
      this.logger.log(`Balance NO: ${utils.formatUnits(balanceNo, 6)}`);

      // Step 3: Calculate merge amount
      let mergeAmount = balanceYes.lt(balanceNo) ? balanceYes : balanceNo;

      if (amount) {
        const requestedAmount = utils.parseUnits(amount.toString(), 6);
        if (requestedAmount.lt(mergeAmount)) {
          mergeAmount = requestedAmount;
        }
      }

      if (mergeAmount.isZero()) {
        const errorMsg =
          'No token pairs available to merge (need both YES and NO)';
        this.logger.error(errorMsg);
        return { success: false, error: errorMsg };
      }

      this.logger.log(
        `Merging ${utils.formatUnits(mergeAmount, 6)} token sets -> USDC`,
      );

      // Step 4: Execute merge
      const gasConfig = await this.getGasConfig(wallet.provider);

      const tx = await ctfContract.mergePositions(
        this.USDC_ADDR,
        marketCondition.parentCollectionId || constants.HashZero,
        marketCondition.conditionId,
        marketCondition.partition || [1, 2],
        mergeAmount,
        gasConfig,
      );

      this.logger.log(`Merge tx sent: ${tx.hash}`);
      await tx.wait();

      const usdcBalance = await usdcContract.balanceOf(wallet.address);
      const usdcBalanceFormatted = utils.formatUnits(usdcBalance, 6);

      this.logger.log(`Merge successful!`);
      this.logger.log(`Current USDC balance: ${usdcBalanceFormatted} USDC`);

      return {
        success: true,
        txHash: tx.hash,
        amountMerged: utils.formatUnits(mergeAmount, 6),
      };
    } catch (error: any) {
      this.logger.error(
        `Error merging positions: ${error.reason || error.message}`,
      );
      return {
        success: false,
        error: error.reason || error.message || 'Merge failed',
      };
    }
  }

  /**
   * Redeem positions (after market is resolved)
   */
  async redeemPositions(
    config: PolymarketConfig,
    marketCondition: MarketCondition,
  ): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
    payoutInfo?: any;
  }> {
    try {
      const wallet = this.buildWallet(config);
      this.logger.log(
        `Starting redeem operation for wallet: ${wallet.address}`,
      );

      const ctfContract = new Contract(this.CTF_ADDR, this.ABIS.CTF, wallet);
      const usdcContract = new Contract(
        this.USDC_ADDR,
        this.ABIS.ERC20,
        wallet,
      );

      // Step 1: Check if market is resolved
      const payoutYes = await ctfContract.payoutNumerators(
        marketCondition.conditionId,
        0,
      );
      const payoutNo = await ctfContract.payoutNumerators(
        marketCondition.conditionId,
        1,
      );

      if (payoutYes.eq(0) && payoutNo.eq(0)) {
        const errorMsg = 'Market not resolved yet. Use merge instead.';
        this.logger.error(errorMsg);
        return { success: false, error: errorMsg };
      }

      this.logger.log(`Market resolved!`);
      this.logger.log(
        `Payout: YES=${payoutYes.toString()}, NO=${payoutNo.toString()}`,
      );

      // Step 2: Get token balances
      const [yesTokenId, noTokenId] = await this.getPositionIds(
        ctfContract,
        marketCondition.conditionId,
      );

      const balances = await ctfContract.balanceOfBatch(
        [wallet.address, wallet.address],
        [yesTokenId, noTokenId],
      );

      const totalTokens = balances[0].add(balances[1]);

      if (totalTokens.isZero()) {
        const errorMsg = 'No tokens to redeem';
        this.logger.error(errorMsg);
        return { success: false, error: errorMsg };
      }

      this.logger.log(
        `Found: ${utils.formatUnits(balances[0], 6)} YES and ${utils.formatUnits(balances[1], 6)} NO`,
      );

      // Step 3: Redeem
      const gasConfig = await this.getGasConfig(wallet.provider);

      const tx = await ctfContract.redeemPositions(
        this.USDC_ADDR,
        marketCondition.parentCollectionId || constants.HashZero,
        marketCondition.conditionId,
        [1, 2], // index sets for YES and NO
        gasConfig,
      );

      this.logger.log(`Redeem tx sent: ${tx.hash}`);
      await tx.wait();

      const usdcBalance = await usdcContract.balanceOf(wallet.address);
      const usdcBalanceFormatted = utils.formatUnits(usdcBalance, 6);

      this.logger.log(`Redeem successful!`);
      this.logger.log(`Current USDC balance: ${usdcBalanceFormatted} USDC`);

      return {
        success: true,
        txHash: tx.hash,
        payoutInfo: {
          payoutYes: payoutYes.toString(),
          payoutNo: payoutNo.toString(),
          usdcBalance: usdcBalanceFormatted,
        },
      };
    } catch (error: any) {
      this.logger.error(
        `Error redeeming positions: ${error.reason || error.message}`,
      );
      return {
        success: false,
        error: error.reason || error.message || 'Redeem failed',
      };
    }
  }

  /**
   * Get wallet balances (USDC and position tokens)
   */
  async getBalances(
    config: PolymarketConfig,
    conditionId?: string,
    overrideAddress?: string,
  ): Promise<{
    usdc: string;
    yesToken?: string;
    noToken?: string;
    address: string;
  }> {
    try {
      // const rpcUrl = new URL(this.RPC_READ_ONLY);
      // const readOnlyProvider = new providers.StaticJsonRpcProvider({
      //   url: `${rpcUrl.protocol}//${rpcUrl.host}${rpcUrl.pathname}`,
      //   headers: rpcUrl.username
      //     ? { Authorization: 'Basic ' + Buffer.from(`${rpcUrl.username}:${rpcUrl.password}`).toString('base64') }
      //     : undefined,
      // }, 137);
      const readOnlyProvider = new providers.JsonRpcProvider(config.polygonRpc);
      const wallet = this.buildWallet(config);
      const targetAddress = overrideAddress || wallet.address;
      const usdcContract = new Contract(
        this.USDC_ADDR,
        this.ABIS.ERC20,
        readOnlyProvider,
      );

      const usdcBalance = await usdcContract.balanceOf(targetAddress);
      const result: any = {
        usdc: utils.formatUnits(usdcBalance, 6),
        address: targetAddress,
      };

      if (conditionId) {
        const ctfContract = new Contract(this.CTF_ADDR, this.ABIS.CTF, readOnlyProvider);
        const [yesTokenId, noTokenId] = await this.getPositionIds(
          ctfContract,
          conditionId,
        );

        const balances = await ctfContract.balanceOfBatch(
          [targetAddress, targetAddress],
          [yesTokenId, noTokenId],
        );

        result.yesToken = utils.formatUnits(balances[0], 6);
        result.noToken = utils.formatUnits(balances[1], 6);
      }

      return result;
    } catch (error: any) {
      this.logger.error(`Error getting balances: ${error.message}`);
      throw error;
    }
  }

  /**
   * Read minted asset balances from Redis for a wallet (cached during mint)
   * Returns map tokenID -> available size (in USDC units)
   */
  async getMintedAssetBalances(
    config: PolymarketConfig,
    groupKey: string,
  ): Promise<Record<string, number>> {
    try {
      // Use proxy address if available, otherwise use wallet address from private key
      const targetAddress = config.proxyAddress || this.buildWallet(config).address;
      return await this.getMintedAssetBalancesByWallet(
        targetAddress,
        groupKey,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to load minted asset balances: ${error.message}`,
      );
      return {};
    }
  }

  /**
   * Internal helper to load minted balances by wallet address
   */
  private async getMintedAssetBalancesByWallet(
    walletAddress: string,
    groupKey: string,
  ): Promise<Record<string, number>> {
    const balances: Record<string, number> = {};

    try {
      const inventoryKey = `mint:inventory:${groupKey}:${walletAddress.toLowerCase()}`;
      const hashBalances = await this.redisService
        .getClient()
        .hgetall(inventoryKey);
      if (hashBalances && Object.keys(hashBalances).length > 0) {
        for (const [tokenId, amountStr] of Object.entries(hashBalances)) {
          const amount = Number(amountStr);
          if (Number.isFinite(amount)) {
            balances[tokenId] = amount;
          }
        }
        return balances;
      }

      // Fallback to legacy structure (per condition key) for backward compatibility
      const normalizedWalletAddress = walletAddress.toLowerCase();
      const conditionIds = await this.redisService.smembers(
        `mint:positions:${normalizedWalletAddress}`,
      );

      if (!conditionIds || conditionIds.length === 0) {
        return balances;
      }

      for (const conditionId of conditionIds) {
        const raw = await this.redisService.get(
          `mint:position:${conditionId}:${normalizedWalletAddress}`,
        );
        if (!raw) continue;

        try {
          const parsed = JSON.parse(raw);
          const amount = Number(parsed.amountUSDC) || 0;
          const ids: string[] = parsed.positionIds || [];
          for (const tokenId of ids) {
            balances[tokenId] = (balances[tokenId] || 0) + amount;
          }
        } catch (parseError: any) {
          this.logger.warn(
            `Failed to parse mint cache for ${conditionId}: ${parseError.message}`,
          );
        }
      }

      // Seed inventory hash cache from legacy data (adds on top of any existing hash)
      if (Object.keys(balances).length > 0) {
        const ttlSeconds = APP_CONSTANTS.MINTED_ASSETS_CACHE_TTL;
        const pipe = this.redisService.getClient().pipeline();
        for (const [tokenId, amount] of Object.entries(balances)) {
          pipe.hincrbyfloat(inventoryKey, tokenId, amount);
        }
        pipe.expire(inventoryKey, ttlSeconds);
        await pipe.exec();
      }
    } catch (error: any) {
      this.logger.error(
        `Error while reading minted assets from Redis: ${error.message}`,
      );
    }

    return balances;
  }

  /**
   * Update minted balances hash for a wallet (delta per token)
   * Positive delta increases, negative decreases
   */
  async updateMintedBalances(
    config: PolymarketConfig,
    groupKey: string,
    deltas: Record<string, number>,
    ttlSeconds: number = APP_CONSTANTS.MINTED_ASSETS_CACHE_TTL,
  ): Promise<void> {
    try {
      // Use proxy address if available, otherwise use wallet address from private key
      const targetAddress = config.proxyAddress || this.buildWallet(config).address;
      const inventoryKey = `mint:inventory:${groupKey}:${targetAddress.toLowerCase()}`;
      const pipe = this.redisService.getClient().pipeline();

      for (const [tokenId, delta] of Object.entries(deltas)) {
        if (!Number.isFinite(delta) || delta === 0) continue;
        pipe.hincrbyfloat(inventoryKey, tokenId, delta);
      }

      pipe.expire(inventoryKey, ttlSeconds);
      await pipe.exec();
    } catch (error: any) {
      this.logger.warn(
        `Failed to update minted balances hash: ${error.message}`,
      );
    }
  }

  /**
   * Cancel all orders for a specific market
   * Optimized: uses cached credentials and client
   */
  async cancelOrders(
    config: PolymarketConfig,
    tokenID?: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Use cached authenticated client
      const client = await this.getOrCreateAuthenticatedClient(config);

      if (tokenID) {
        await client.cancelMarketOrders({ market: tokenID });
        this.logger.log(`Cancelled all orders for token: ${tokenID}`);
      } else {
        await client.cancelAll();
        this.logger.log('Cancelled all orders');
      }

      return { success: true };
    } catch (error: any) {
      this.logger.error(`Error cancelling orders: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Clear cached credentials and clients for a specific wallet address
   * Useful when credentials expire or need to be refreshed
   */
  clearCache(walletAddress?: string): void {
    if (walletAddress) {
      this.credentialsCache.delete(walletAddress);
      this.clientCache.delete(walletAddress);
      this.logger.log(`Cache cleared for wallet: ${walletAddress}`);
    } else {
      this.credentialsCache.clear();
      this.clientCache.clear();
      this.logger.log('All caches cleared');
    }
  }

  /**
   * Get default config loaded from environment variables
   * Useful for operations that don't need a specific config
   */
  getDefaultConfig(): PolymarketConfig | undefined {
    return this.defaultConfig;
  }

  /**
   * Execute a transaction through a Gnosis Safe proxy (single-signer)
   */
  private async execProxyTx(
    owner: Wallet,
    proxyAddress: string,
    to: string,
    data: string,
  ): Promise<providers.TransactionResponse> {
    const proxy = new Contract(proxyAddress, this.ABIS.GNOSIS_SAFE, owner);
    const provider = owner.provider!;

    const nonce = await proxy.nonce();

    const safeTx = {
      to,
      value: 0,
      data,
      operation: 0,
      safeTxGas: 0,
      baseGas: 0,
      gasPrice: 0,
      gasToken: constants.AddressZero,
      refundReceiver: constants.AddressZero,
      nonce: nonce.toNumber(),
    };

    const network = await provider.getNetwork();
    const domain = {
      verifyingContract: proxyAddress,
      chainId: Number(network.chainId),
    };
    const types = {
      SafeTx: [
        { type: 'address', name: 'to' },
        { type: 'uint256', name: 'value' },
        { type: 'bytes', name: 'data' },
        { type: 'uint8', name: 'operation' },
        { type: 'uint256', name: 'safeTxGas' },
        { type: 'uint256', name: 'baseGas' },
        { type: 'uint256', name: 'gasPrice' },
        { type: 'address', name: 'gasToken' },
        { type: 'address', name: 'refundReceiver' },
        { type: 'uint256', name: 'nonce' },
      ],
    };

    const signature = await owner._signTypedData(domain, types, safeTx);

    const feeData = await provider.getFeeData();
    const defaultGas = utils.parseUnits('800', 'gwei');
    const floor = utils.parseUnits('800', 'gwei'); // enforce >= 800 gwei
    const bump = (v: any) => v.mul(120).div(100); // +20%
    const baseMaxFee = feeData.maxFeePerGas || defaultGas;
    const baseMaxPrio = feeData.maxPriorityFeePerGas || defaultGas;
    const maxFeePerGas = bump(baseMaxFee).lt(floor) ? floor : bump(baseMaxFee);
    const maxPriorityFeePerGas = bump(baseMaxPrio).lt(floor)
      ? floor
      : bump(baseMaxPrio);

    return proxy.execTransaction(
      safeTx.to,
      safeTx.value,
      safeTx.data,
      safeTx.operation,
      safeTx.safeTxGas,
      safeTx.baseGas,
      safeTx.gasPrice,
      safeTx.gasToken,
      safeTx.refundReceiver,
      signature,
      {
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        gasLimit: 18_000_000,
      },
    );
  }

  /**
   * Mint tokens directly in proxy wallet via Safe.execTransaction
   */
  async mintTokensViaProxy(
    config: PolymarketConfig,
    marketCondition: MarketCondition,
    amountUSDC: number,
    groupKey: string,
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    try {
      if (!config.proxyAddress) {
        return {
          success: false,
          error: 'proxyAddress is required for proxy mint',
        };
      }

      const owner = this.buildWallet(config);
      const provider = owner.provider!;
      const proxyAddress = config.proxyAddress;

      const usdc = new Contract(this.USDC_ADDR, this.ABIS.ERC20, provider);
      const erc20Interface = new utils.Interface(this.ABIS.ERC20);

      const decimals = await usdc.decimals();
      const amountWei = utils.parseUnits(amountUSDC.toString(), decimals);

      // 1. Check proxy balance
      const balanceProxy = await usdc.balanceOf(proxyAddress);
      if (balanceProxy.lt(amountWei)) {
        const have = utils.formatUnits(balanceProxy, decimals);
        return {
          success: false,
          error: `Proxy insufficient USDC. Have ${have}, need ${amountUSDC}`,
        };
      }

      // Determine target contract and calldata (NegRisk vs Standard)
      let targetContractAddr: string;
      let txData: string | undefined;
      let spenderAddress: string;

      if (marketCondition.negRisk && marketCondition.negRiskMarketID) {
        this.logger.log(`Detected NegRisk market. Using adapter...`);
        targetContractAddr = this.NEGRISK_ADAPTER_ADDR;
        spenderAddress = this.NEGRISK_ADAPTER_ADDR;
        const adapterInterface = new utils.Interface(this.ABIS.NEGRISK_ADAPTER);
        txData = adapterInterface.encodeFunctionData('splitPosition', [
          marketCondition.conditionId,
          amountWei,
        ]);
      } else {
        // Standard binary flow
        const ctfInterface = new utils.Interface(this.ABIS.CTF);
        targetContractAddr = this.CTF_ADDR;
        spenderAddress = this.CTF_ADDR;
        const partition = this.sanitizePartition(marketCondition.partition);
        const parentCollectionId =
          marketCondition.parentCollectionId || constants.HashZero;
        txData = ctfInterface.encodeFunctionData('splitPosition', [
          this.USDC_ADDR,
          parentCollectionId,
          marketCondition.conditionId,
          partition,
          amountWei,
        ]);
      }

      // 2. Approve if needed (proxy -> target)
      const allowance = await usdc.allowance(proxyAddress, spenderAddress);

      if (allowance.lt(amountWei)) {
        this.logger.log(`FORCE APPROVING USDC for ${spenderAddress}...`);
        const approveData = erc20Interface.encodeFunctionData('approve', [
          spenderAddress,
          constants.MaxUint256,
        ]);

        const txApprove = await this.execProxyTx(
          owner,
          proxyAddress,
          this.USDC_ADDR,
          approveData,
        );

        await txApprove.wait();
        this.logger.log('Force Approve Confirmed!');
      }

      //   return;

      // 3. Execute mint (adapter or CTF) from proxy
      if (!txData) {
        return { success: false, error: 'Failed to build transaction data' };
      }

      const txMint = await this.execProxyTx(
        owner,
        proxyAddress,
        targetContractAddr,
        txData,
      );
      await txMint.wait();

      // 4. Save inventory for standard markets; NegRisk requires outcome token IDs which aren't derived here
      if (!(marketCondition.negRisk && marketCondition.negRiskMarketID)) {
        const ctfContract = new Contract(this.CTF_ADDR, this.ABIS.CTF, owner);
        const partition = this.sanitizePartition(marketCondition.partition);
        const parentCollectionId =
          marketCondition.parentCollectionId || constants.HashZero;
        const positionIds = await Promise.all(
          partition.map(async (indexSet) => {
            const collectionId = await ctfContract.getCollectionId(
              parentCollectionId,
              marketCondition.conditionId,
              indexSet,
            );
            return ctfContract.getPositionId(this.USDC_ADDR, collectionId);
          }),
        );

        await this.saveMintPositionToRedis(
          proxyAddress,
          groupKey,
          positionIds.map((id) => id.toString()),
          amountUSDC.toString(),
          txMint.hash,
        );
      } else {
        this.logger.log(
          'NegRisk mint executed; inventory tracking for outcomes not recorded (adapter returns whole set).',
        );
        const parentCollectionId = constants.HashZero;
        const ctfContract = new Contract(this.CTF_ADDR, this.ABIS.CTF, owner);
        const adapterContract = new Contract(
          this.NEGRISK_ADAPTER_ADDR,
          this.ABIS.NEGRISK_ADAPTER,
          owner,
        );
        const wcolAddress = await adapterContract.wcol();
        // Tính Collection ID cho YES (Index 1) và NO (Index 2)
        const collectionIdYes = await ctfContract.getCollectionId(
          parentCollectionId,
          marketCondition.conditionId,
          1,
        );
        const collectionIdNo = await ctfContract.getCollectionId(
          parentCollectionId,
          marketCondition.conditionId,
          2,
        );

        // Tính Position ID (Token ID) dựa trên WCOL
        const tokenIdYes = await ctfContract.getPositionId(
          wcolAddress,
          collectionIdYes,
        );
        const tokenIdNo = await ctfContract.getPositionId(
          wcolAddress,
          collectionIdNo,
        );

        const tokenIds = [tokenIdYes.toString(), tokenIdNo.toString()];
        this.logger.log(
          `Captured Token IDs: YES=${tokenIds[0]}, NO=${tokenIds[1]}`,
        );

        // 4. Lưu Inventory vào Redis
        await this.saveMintPositionToRedis(
          proxyAddress,
          groupKey,
          tokenIds,
          amountUSDC.toString(),
          txMint.hash,
        );
      }

      return { success: true, txHash: txMint.hash };
    } catch (error: any) {
      this.logger.error(`Error minting via proxy: ${error.message || error}`);
      return {
        success: false,
        error: error.message || 'Mint via proxy failed',
      };
    }
  }

  /**
   * Export Redis data for sync purposes
   * Returns all keys matching the pattern with their values and metadata
   * Default pattern: mint:* (includes mint:inventory and mint:history)
   */
  async exportRedisData(pattern: string = 'mint:*'): Promise<
    Array<{
      key: string;
      type: string;
      value: any;
      ttl?: number;
    }>
  > {
    try {
      const client = this.redisService.getClient();
      const keys = await client.keys(pattern);

      this.logger.log(`Found ${keys.length} keys matching pattern: ${pattern}`);

      const results = [];

      for (const key of keys) {
        const type = await client.type(key);
        const ttl = await client.ttl(key);
        let value: any;

        switch (type) {
          case 'string':
            value = await client.get(key);
            break;
          case 'hash':
            value = await client.hgetall(key);
            break;
          case 'list':
            value = await client.lrange(key, 0, -1);
            break;
          case 'set':
            value = await client.smembers(key);
            break;
          case 'zset':
            value = await client.zrange(key, 0, -1, 'WITHSCORES');
            break;
          default:
            this.logger.warn(`Unsupported type ${type} for key ${key}`);
            continue;
        }

        results.push({
          key,
          type,
          value,
          ttl: ttl > 0 ? ttl : undefined, // Only include TTL if it's positive
        });
      }

      return results;
    } catch (error: any) {
      this.logger.error(`Error exporting Redis data: ${error.message}`);
      throw error;
    }
  }

  /**
   * Import Redis data from exported format
   * Overwrites existing keys with new data
   */
  async importRedisData(
    data: Array<{
      key: string;
      type: string;
      value: any;
      ttl?: number;
    }>,
  ): Promise<{
    imported: number;
    failed: number;
    errors: Array<{ key: string; error: string }>;
  }> {
    const client = this.redisService.getClient();
    let imported = 0;
    let failed = 0;
    const errors: Array<{ key: string; error: string }> = [];

    this.logger.log(`Starting import of ${data.length} Redis keys`);

    for (const item of data) {
      try {
        const { key, type, value, ttl } = item;

        // Delete existing key first to ensure clean overwrite
        await client.del(key);

        // Set value based on type
        switch (type) {
          case 'string':
            await client.set(key, value);
            break;
          case 'hash':
            if (Object.keys(value).length > 0) {
              await client.hset(key, value);
            }
            break;
          case 'list':
            if (Array.isArray(value) && value.length > 0) {
              await client.rpush(key, ...value);
            }
            break;
          case 'set':
            if (Array.isArray(value) && value.length > 0) {
              await client.sadd(key, ...value);
            }
            break;
          case 'zset':
            if (Array.isArray(value) && value.length > 0) {
              // value format: [member1, score1, member2, score2, ...]
              const args: Array<string | number> = [];
              for (let i = 0; i < value.length; i += 2) {
                args.push(value[i + 1]); // score
                args.push(value[i]); // member
              }
              if (args.length > 0) {
                await client.zadd(key, ...args);
              }
            }
            break;
          default:
            throw new Error(`Unsupported type: ${type}`);
        }

        // Set TTL if provided
        if (ttl && ttl > 0) {
          await client.expire(key, ttl);
        }

        imported++;
        this.logger.log(`Imported key: ${key} (type: ${type})`);
      } catch (error: any) {
        failed++;
        const errorMsg = error.message || 'Unknown error';
        errors.push({ key: item.key, error: errorMsg });
        this.logger.error(`Failed to import key ${item.key}: ${errorMsg}`);
      }
    }

    this.logger.log(
      `Import complete: ${imported} successful, ${failed} failed`,
    );

    return { imported, failed, errors };
  }

  /**
   * Clear all mint:* keys from Redis
   */
  async clearMintKeys(): Promise<{ success: boolean; count: number; message: string }> {
    try {
      this.logger.log('Clearing all mint:* keys from Redis...');
      const count = await this.redisService.deleteByPattern('mint:*');
      this.logger.log(`Cleared ${count} keys matching mint:*`);

      return {
        success: true,
        count,
        message: `Successfully cleared ${count} keys matching mint:*`
      };
    } catch (error: any) {
      this.logger.error(`Failed to clear mint keys: ${error.message}`);
      return {
        success: false,
        count: 0,
        message: `Failed to clear mint keys: ${error.message}`
      };
    }
  }

  /**
   * Get order details by order hash
   * Uses the CLOB client's getOrder method with L2 authentication
   * @param orderHash The order hash/ID to query
   * @returns Order details or error
   */
  async getOrder(orderHash: string): Promise<{
    success: boolean;
    order?: any;
    error?: string;
  }> {
    try {
      const config = this.getDefaultConfig();
      if (!config) {
        return { success: false, error: 'Default config not available' };
      }

      const client = await this.getOrCreateAuthenticatedClient(config);
      const order = await client.getOrder(orderHash);

      if (order) {
        return { success: true, order };
      } else {
        return { success: false, error: 'Order not found' };
      }
    } catch (error: any) {
      this.logger.error(`Error getting order ${orderHash}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get open/active orders for a specific market
   * Uses the CLOB client's getOpenOrders method with L2 authentication
   * @param market The market conditionId to query (optional - if not provided, gets all open orders)
   * @returns Array of open orders or error
   */
  async getOpenOrders(market?: string): Promise<{
    success: boolean;
    orders?: any[];
    error?: string;
  }> {
    try {
      const config = this.getDefaultConfig();
      if (!config) {
        return { success: false, error: 'Default config not available' };
      }

      const client = await this.getOrCreateAuthenticatedClient(config);

      const params = market ? { market } : {};
      const orders = await client.getOpenOrders(params);

      return {
        success: true,
        orders: Array.isArray(orders) ? orders : []
      };
    } catch (error: any) {
      this.logger.error(`Error getting open orders: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get trades for a specific market and/or maker address
   * Uses the CLOB client's getTrades method with L2 authentication
   * @param id Optional trade ID to fetch a specific trade
   * @param market Optional market conditionId to filter trades
   * @param makerAddress Optional maker address to filter trades (defaults to current wallet)
   * @returns Array of trades or error
   */
  async getTrades(params?: {
    id?: string;
    market?: string;
    makerAddress?: string;
  }): Promise<{
    success: boolean;
    trades?: any[];
    error?: string;
  }> {
    try {
      const config = this.getDefaultConfig();
      if (!config) {
        return { success: false, error: 'Default config not available' };
      }

      const client = await this.getOrCreateAuthenticatedClient(config);
      const wallet = this.buildWallet(config);

      // Build query params
      const queryParams: { id?: string; market?: string; maker_address?: string } = {};

      if (params?.id) {
        queryParams.id = params.id;
      }

      if (params?.market) {
        queryParams.market = params.market;
      }

      // Use provided makerAddress or default to current wallet address
      queryParams.maker_address = params?.makerAddress || wallet.address;

      const trades = await client.getTrades(queryParams);

      return {
        success: true,
        trades: Array.isArray(trades) ? trades : []
      };
    } catch (error: any) {
      this.logger.error(`Error getting trades: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
