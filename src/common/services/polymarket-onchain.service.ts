import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Contract, Wallet, providers, utils, constants } from 'ethers';
import type {
  ApiKeyCreds,
  ClobClient as ClobClientType,
} from '@polymarket/clob-client';
import { loadPolymarketConfig } from './polymarket-onchain.config';

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

  // Default config loaded from environment variables
  private defaultConfig?: PolymarketConfig;

  constructor(private readonly configService: ConfigService) {}

  // Contract addresses (Fixed for Polygon)
  private readonly CTF_EXCHANGE_ADDR =
    '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
  private readonly CTF_ADDR = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
  private readonly USDC_ADDR = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

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
    ],
  };

  async onApplicationBootstrap(): Promise<void> {
    try {
      this.logger.log('Initializing Polymarket Onchain Service...');

      // Pre-load CLOB client module to avoid cold start delays
      this.logger.log('Loading CLOB client module...');
      await this.loadClob();
      this.logger.log('CLOB client module loaded successfully');

      // Load default config from environment variables
      try {
        this.defaultConfig = loadPolymarketConfig();
        this.logger.log(
          `Default config loaded for wallet: ${this.defaultConfig ? new Wallet(this.defaultConfig.privateKey).address : 'N/A'}`,
        );

        // Pre-create API credentials for default wallet
        if (this.defaultConfig && this.defaultConfig.privateKey) {
          this.logger.log('Creating API credentials for default wallet...');
          const wallet = this.buildWallet(this.defaultConfig);
          await this.getOrCreateCredentials(wallet, this.defaultConfig);
          this.logger.log(
            '✅ API credentials created and cached for default wallet',
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
   */
  private sanitizePartition(partition?: number[]): number[] {
    if (!Array.isArray(partition)) return [1, 2];

    const cleaned = Array.from(
      new Set(partition.filter((v) => Number.isInteger(v) && v > 0)),
    );

    return cleaned.length ? cleaned : [1, 2];
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
   * Build wallet from private key
   */
  private buildWallet(config: PolymarketConfig): Wallet {
    const provider = new providers.JsonRpcProvider(config.polygonRpc);
    return new Wallet(config.privateKey, provider);
  }

  /**
   * Get or create API credentials (cached by wallet address)
   */
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
      // Use cached authenticated client (credentials are created once and reused)
      const client = await this.getOrCreateAuthenticatedClient(config);

      // Create and post order
      const { OrderType, Side } = await this.loadClob();

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

      // Use cached authenticated client
      const client = await this.getOrCreateAuthenticatedClient(config);

      // Load clob types once
      const { OrderType, Side } = await this.loadClob();

      // Map OrderType strings to enum values
      const orderTypeMap: Record<string, any> = {
        GTC: OrderType.GTC,
        GTD: OrderType.GTD,
        FOK: OrderType.FOK,
        FAK: OrderType.FAK,
      };

      // Create all orders in parallel for maximum speed
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

      // Post batch orders
      const responses = await client.postOrders(batchOrdersArgs);

      // Process responses
      const results: BatchOrderResult[] = [];
      let successCount = 0;
      let failureCount = 0;

      if (Array.isArray(responses)) {
        for (let i = 0; i < responses.length; i++) {
          const response = responses[i];

          if (response && response.orderID) {
            successCount++;
            results.push({
              success: true,
              orderID: response.orderID,
              status: response.status || 'unknown',
              errorMsg: response.errorMsg || '',
            });
          } else {
            failureCount++;
            results.push({
              success: false,
              errorMsg: response?.errorMsg || `Order ${i + 1} placement failed`,
            });
          }
        }
      }

      this.logger.log(
        `Batch complete: ${successCount} success, ${failureCount} failed`,
      );

      return {
        success: true,
        results,
      };
    } catch (error: any) {
      this.logger.error(`Error placing batch orders: ${error.message}`);
      if (error.response?.data) {
        this.logger.error(
          `Server response: ${JSON.stringify(error.response.data)}`,
        );
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Mint tokens (split position) by depositing USDC
   */
  async mintTokens(
    config: PolymarketConfig,
    marketCondition: MarketCondition,
    amountUSDC: number,
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

      // Transfer freshly minted tokens to proxy wallet if configured
      const proxyAddress = config.proxyAddress;
      const parentCollectionId =
        marketCondition.parentCollectionId || constants.HashZero;
      let transferTxHash: string | undefined;

      if (proxyAddress) {
        if (proxyAddress.toLowerCase() === wallet.address.toLowerCase()) {
          this.logger.log(
            'Proxy address matches signer wallet, skipping transfer',
          );
        } else {
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
          this.logger.log(
            `Tokens transferred to proxy wallet ${proxyAddress}`,
          );
        }
      } else {
        this.logger.warn(
          'proxyAddress not provided; minted tokens remain in signer wallet',
        );
      }

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
  ): Promise<{
    usdc: string;
    yesToken?: string;
    noToken?: string;
    address: string;
  }> {
    try {
      const wallet = this.buildWallet(config);
      const usdcContract = new Contract(
        this.USDC_ADDR,
        this.ABIS.ERC20,
        wallet,
      );

      const usdcBalance = await usdcContract.balanceOf(wallet.address);
      const result: any = {
        usdc: utils.formatUnits(usdcBalance, 6),
        address: wallet.address,
      };

      if (conditionId) {
        const ctfContract = new Contract(this.CTF_ADDR, this.ABIS.CTF, wallet);
        const [yesTokenId, noTokenId] = await this.getPositionIds(
          ctfContract,
          conditionId,
        );

        const balances = await ctfContract.balanceOfBatch(
          [wallet.address, wallet.address],
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
}
